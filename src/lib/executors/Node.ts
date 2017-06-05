import Executor, { Config as BaseConfig, Events as BaseEvents, LoaderDescriptor, PluginDescriptor } from './Executor';
import Task from '@dojo/core/async/Task';
import { parseValue, pullFromArray } from '../common/util';
import { expandFiles, normalizePath, readSourceMap } from '../node/util';
import { readFileSync } from 'fs';
import { deepMixin, mixin } from '@dojo/core/lang';
import ErrorFormatter from '../node/ErrorFormatter';
import { dirname, normalize, relative, resolve, sep } from 'path';
import LeadfootServer from 'leadfoot/Server';
import ProxiedSession from '../ProxiedSession';
import Environment from '../Environment';
import resolveEnvironments from '../resolveEnvironments';
import Command from 'leadfoot/Command';
import Pretty from '../reporters/Pretty';
import Runner from '../reporters/Runner';
import Simple from '../reporters/Simple';
import JsonCoverage from '../reporters/JsonCoverage';
import HtmlCoverage from '../reporters/HtmlCoverage';
import LcovCoverage from '../reporters/LcovCoverage';
import Benchmark from '../reporters/Benchmark';
import Promise from '@dojo/shim/Promise';
import Tunnel, { TunnelOptions, DownloadProgressEvent } from 'digdug/Tunnel';
import BrowserStackTunnel, { BrowserStackOptions } from 'digdug/BrowserStackTunnel';
import SeleniumTunnel, { SeleniumOptions } from 'digdug/SeleniumTunnel';
import SauceLabsTunnel from 'digdug/SauceLabsTunnel';
import TestingBotTunnel from 'digdug/TestingBotTunnel';
import CrossBrowserTestingTunnel from 'digdug/CrossBrowserTestingTunnel';
import NullTunnel from 'digdug/NullTunnel';
import Server from '../Server';
import Suite, { isSuite } from '../Suite';
import RemoteSuite from '../RemoteSuite';
import { CoverageMap, createCoverageMap } from 'istanbul-lib-coverage';
import { createInstrumenter, Instrumenter, readInitialCoverage } from 'istanbul-lib-instrument';
import { createSourceMapStore, MapStore } from 'istanbul-lib-source-maps';
import { hookRunInThisContext, hookRequire, unhookRunInThisContext } from 'istanbul-lib-hook';
import global from '@dojo/core/global';

const console: Console = global.console;

export default class Node extends Executor<Events, Config> {
	server: Server;
	tunnel: Tunnel;

	protected _coverageMap: CoverageMap;
	protected _loadingFunctionalSuites: boolean;
	protected _instrumentBasePath: string;
	protected _instrumenter: Instrumenter;
	protected _sourceMaps: MapStore;
	protected _instrumentedMaps: MapStore;
	protected _unhookRequire: null | (() => void);
	protected _sessionSuites: Suite[];
	protected _tunnels: { [name: string]: typeof Tunnel };

	constructor(config?: Partial<Config>) {
		super({
			basePath: process.cwd() + sep,
			browserSuites: <string[]>[],
			capabilities: { 'idle-timeout': 60 },
			connectTimeout: 30000,
			environments: <EnvironmentSpec[]>[],
			functionalCoverage: true,
			functionalSuites: <string[]>[],
			maxConcurrency: Infinity,
			name: 'node',
			nodePlugins: <PluginDescriptor[]>[],
			nodeSuites: <string[]>[],
			reporters: [{ name: 'runner' }],
			runInSync: false,
			serveOnly: false,
			serverPort: 9000,
			serverUrl: 'http://localhost:9000',
			tunnel: 'selenium',
			tunnelOptions: { tunnelId: String(Date.now()) }
		});

		this._tunnels = {};
		this._sourceMaps = createSourceMapStore();
		this._instrumentedMaps = createSourceMapStore();
		this._errorFormatter = new ErrorFormatter(this);
		this._coverageMap = createCoverageMap();

		this.registerReporter('pretty', Pretty);
		this.registerReporter('simple', Simple);
		this.registerReporter('runner', Runner);
		this.registerReporter('benchmark', Benchmark);
		this.registerReporter('jsoncoverage', JsonCoverage);
		this.registerReporter('htmlcoverage', HtmlCoverage);
		this.registerReporter('lcovcoverage', LcovCoverage);

		this.registerTunnel('null', NullTunnel);
		this.registerTunnel('selenium', SeleniumTunnel);
		this.registerTunnel('saucelabs', SauceLabsTunnel);
		this.registerTunnel('browserstack', BrowserStackTunnel);
		this.registerTunnel('testingbot', TestingBotTunnel);
		this.registerTunnel('cbt', CrossBrowserTestingTunnel);

		if (config) {
			this.configure(config);
		}

		// Report uncaught errors
		process.on('unhandledRejection', (reason: Error, promise: Promise<any>) => {
			if (!this._listeners['error'] || this._listeners['error'].length === 0) {
				console.warn('Unhandled rejection:', promise);
			}
			reason.message = 'Unhandled rejection: ' + reason.message;
			this.emit('error', reason);
		});

		process.on('uncaughtException', (reason: Error) => {
			if (!this._listeners['error'] || this._listeners['error'].length === 0) {
				console.warn('Unhandled error:', reason);
			}
			reason.message = 'Uncaught exception: ' + reason.message;
			this.emit('error', reason);
		});

		this.on('coverage', message => {
			this._coverageMap.merge(message.coverage);
		});
	}

	get coverageMap() {
		return this._coverageMap;
	}

	get environment() {
		return 'node' as 'node';
	}

	get instrumentedMapStore() {
		return this._instrumentedMaps;
	}

	get sourceMapStore() {
		return this._sourceMaps;
	}

	/**
	 * Override Executor#addSuite to handle functional suites
	 */
	addSuite(factory: (parentSuite: Suite) => void) {
		if (this._loadingFunctionalSuites) {
			this._sessionSuites.forEach(factory);
		}
		else {
			super.addSuite(factory);
		}
	}

	/**
	 * Insert coverage instrumentation into a given code string
	 */
	instrumentCode(code: string, filename: string): string {
		this.log('Instrumenting', filename);
		const sourceMap = readSourceMap(filename, code);
		if (sourceMap) {
			this._sourceMaps.registerMap(filename, sourceMap);
		}
		const newCode = this._instrumenter.instrumentSync(code, normalize(filename), sourceMap);
		this._instrumentedMaps.registerMap(filename, this._instrumenter.lastSourceMap());
		return newCode;
	}

	/**
	 * Load scripts using Node's require
	 */
	loadScript(script: string | string[]) {
		if (!Array.isArray(script)) {
			script = [script];
		}

		script.forEach(script => {
			script = resolve(script);
			// Delete the module cache entry for the script to ensure it will be loaded and executed again.
			delete require.cache[script];
			require(script);
		});

		return Task.resolve();
	}

	/**
	 * Register a tunnel class
	 */
	registerTunnel(name: string, Class: typeof Tunnel) {
		this._tunnels[name] = Class;
	}

	/**
	 * Return true if a given file should be instrumented based on the current config
	 */
	shouldInstrumentFile(filename: string) {
		const excludeInstrumentation = this.config.excludeInstrumentation;
		if (excludeInstrumentation === true) {
			return false;
		}

		const basePath = this._instrumentBasePath;
		filename = normalizePath(filename);
		return filename.indexOf(basePath) === 0 && !excludeInstrumentation.test(filename.slice(basePath.length));
	}

	protected _afterRun() {
		return super._afterRun().finally(() => {
			const promises: Promise<any>[] = [];
			if (this.server) {
				promises.push(this.server.stop().then(() => this.emit('serverEnd', this.server)));
			}
			if (this.tunnel) {
				promises.push(this.tunnel.stop().then(() => this.emit('tunnelStop', { tunnel: this.tunnel })));
			}
			return Promise.all(promises)
			// We do not want to actually return an array of values, so chain a callback that resolves to
			// undefined
				.then(() => {}, error => this.emit('error', error));
		});
	}

	protected _beforeRun(): Task<void> {
		return super._beforeRun().then(() => {
			const config = this.config;

			this._instrumenter = createInstrumenter(mixin({}, config.instrumenterOptions, {
				preserveComments: true,
				produceSourceMap: true
			}));

			if (this.config.excludeInstrumentation !== true) {
				this._setInstrumentationHooks();
			}

			const suite = this._rootSuite;
			suite.grep = config.grep;
			suite.timeout = config.defaultTimeout;
			suite.bail = config.bail;

			if (
				config.environments.length > 0 && (config.functionalSuites.length + config.suites.length + config.browserSuites.length > 0) ||
				// User can start the server without planning to run functional tests
				config.serveOnly
			) {
				const serverTask = new Task<void>((resolve, reject) => {
					const server: Server = new Server({
						basePath: config.basePath,
						executor: this,
						port: config.serverPort,
						runInSync: config.runInSync,
						socketPort: config.socketPort
					});

					server.start().then(() => {
						this.server = server;
						return this.emit('serverStart', server);
					}).then(resolve, reject);
				});

				// If we're in serveOnly mode, just start the server server. Don't create session suites or start a tunnel.
				if (config.serveOnly) {
					return serverTask.then(() => {
						// This is normally handled in Executor#run, but in serveOnly mode we short circuit the normal
						// sequence Pause indefinitely until canceled
						return new Task<void>(() => {}).finally(() => this.server && this.server.stop());
					});
				}

				return serverTask.then(() => {
					if (config.tunnel === 'browserstack') {
						const options = <BrowserStackOptions>config.tunnelOptions;
						options.servers = options.servers || [];
						options.servers.push(config.serverUrl);
					}

					let TunnelConstructor = this._tunnels[config.tunnel];
					const tunnel = this.tunnel = new TunnelConstructor(this.config.tunnelOptions);

					tunnel.on('downloadprogress', progress => {
						this.emit('tunnelDownloadProgress', { tunnel, progress });
					});

					tunnel.on('status', status => {
						this.emit('tunnelStatus', { tunnel, status: status.status });
					});

					config.capabilities = deepMixin(tunnel.extraCapabilities, config.capabilities);

					return this._createSessionSuites().then(() => {
						return tunnel.start().then(() => this.emit('tunnelStart', { tunnel }));
					});
				});
			}
		});
	}

	/**
	 * Creates suites for each environment in which tests will be executed. This method will only be called if there are
	 * both environments and suites to run.
	 */
	protected _createSessionSuites() {
		const tunnel = this.tunnel;
		const config = this.config;

		const leadfootServer = new LeadfootServer(tunnel.clientUrl, {
			proxy: tunnel.proxy
		});

		const executor = this;

		// Create a subclass of ProxiedSession here that will ensure the executor is set
		class InitializedProxiedSession extends ProxiedSession {
			executor = executor;
			coverageEnabled = config.functionalCoverage && config.excludeInstrumentation !== true;
			coverageVariable = config.instrumenterOptions.coverageVariable;
			serverUrl = config.serverUrl;
			serverBasePathLength = config.basePath.length;
		}

		leadfootServer.sessionConstructor = InitializedProxiedSession;

		return tunnel.getEnvironments().then(tunnelEnvironments => {
			this._sessionSuites = resolveEnvironments(
				config.capabilities,
				config.environments,
				tunnelEnvironments
			).map(environmentType => {
				let session: ProxiedSession;

				// Create a new root suite for each environment
				const suite = new Suite({
					name: String(environmentType),
					publishAfterSetup: true,
					grep: config.grep,
					bail: config.bail,
					tests: [],
					timeout: config.defaultTimeout,
					executor: this,

					before() {
						executor.log('Creating session for', environmentType);
						return leadfootServer.createSession<ProxiedSession>(environmentType).then(_session => {
							session = _session;
							this.executor.log('Created session:', session.capabilities);

							let remote: Remote = <Remote>new Command(session);
							remote.environmentType = new Environment(session.capabilities);
							this.remote = remote;
							this.sessionId = remote.session.sessionId;
						});
					},

					after() {
						const remote = this.remote;

						if (remote) {
							const endSession = () => {
								// Check for an error in this suite or a sub-suite. This check is a bit more
								// involved than just checking for a local suite error or failed tests since
								// sub-suites may have failures that don't result in failed tests.
								function hasError(suite: Suite): boolean {
									if (suite.error != null || suite.numFailedTests > 0) {
										return true;
									}
									return suite.tests.filter(isSuite).some(hasError);
								}
								return tunnel.sendJobState(remote.session.sessionId, { success: !hasError(this) });
							};

							if (
								config.leaveRemoteOpen === true ||
								(config.leaveRemoteOpen === 'fail' && this.numFailedTests > 0)
							) {
								return endSession();
							}

							return remote.quit().finally(endSession);
						}
					}
				});

				// If browser-compatible unit tests were added to this executor, add a RemoteSuite to the session suite.
				// The RemoteSuite will run the suites listed in executor.config.suites.
				if (config.suites.length + config.browserSuites.length > 0) {
					suite.add(new RemoteSuite({
						before() {
							session.coverageEnabled = config.excludeInstrumentation !== true;
						}
					}));
				}

				return suite;
			});
		});
	}

	/**
	 * Override Executor#_loadPlugins to pass a combination of nodePlugins and plugins to the loader.
	 */
	protected _loadPlugins() {
		return super._loadPlugins(this.config.plugins.concat(this.config.nodePlugins));
	}

	/**
	 * Override Executor#_loadSuites to pass a combination of nodeSuites and suites to the loader.
	 */
	protected _loadSuites() {
		const config = this.config;
		this._loadingFunctionalSuites = false;
		return super._loadSuites(config.suites.concat(config.nodeSuites), config.nodeLoader);
	}

	/**
	 * Load functional test suites
	 */
	protected _loadFunctionalSuites() {
		const config = this.config;
		this._loadingFunctionalSuites = true;
		return super._loadSuites(config.functionalSuites, config.nodeLoader);
	}

	protected _processOption(name: keyof Config, value: any, addToExisting: boolean) {
		switch (name) {
			case 'serverUrl':
				this._setOption(name, parseValue(name, value, 'string'));
				break;

			case 'capabilities':
			case 'tunnelOptions':
				this._setOption(name, parseValue(name, value, 'object'));
				break;

			// Must be a string, object, or array of (string | object)
			case 'environments':
				if (!value) {
					value = [];
				}
				else if (typeof value === 'string') {
					try {
						value = parseValue(name, value, 'object');
					}
					catch (error) {
						value = { browserName: value };
					}
				}

				if (!Array.isArray(value)) {
					value = [value];
				}

				value = value.map((val: any) => {
					if (typeof val === 'string') {
						try {
							val = parseValue(name, val, 'object');
						}
						catch (error) {
							val = { browserName: val };
						}
					}
					if (typeof val !== 'object') {
						throw new Error(`Invalid value "${value}" for ${name}; must (string | object)[]`);
					}
					// Do some very basic normalization
					if (val.browser && !val.browserName) {
						val.browserName = val.browser;
					}
					return val;
				});

				this._setOption(name, value, addToExisting);
				break;

			case 'tunnel':
				if (typeof value !== 'string' && typeof value !== 'function') {
					throw new Error(`Invalid value "${value}" for ${name}`);
				}
				this._setOption(name, value);
				break;

			case 'browserPlugins':
			case 'nodePlugins':
				this._setOption(name, parseValue(name, value, 'object[]', 'script'), addToExisting);
				break;

			case 'browserLoader':
			case 'nodeLoader':
				this._setOption(name, parseValue(name, value, 'object', 'script'));
				break;

			case 'functionalCoverage':
			case 'leaveRemoteOpen':
			case 'serveOnly':
			case 'runInSync':
				this._setOption(name, parseValue(name, value, 'boolean'));
				break;

			case 'coverageSources':
			case 'browserSuites':
			case 'functionalSuites':
			case 'nodeSuites':
				this._setOption(name, parseValue(name, value, 'string[]'), addToExisting);
				break;

			case 'connectTimeout':
			case 'maxConcurrency':
			case 'serverPort':
			case 'socketPort':
				this._setOption(name, parseValue(name, value, 'number'));
				break;

			default:
				super._processOption(<keyof BaseConfig>name, value, addToExisting);
				break;
		}
	}

	protected _resolveConfig() {
		return super._resolveConfig().then(() => {
			const config = this.config;

			if (!config.internPath) {
				config.internPath = dirname(dirname(__dirname));
			}

			config.internPath = `${relative(process.cwd(), config.internPath)}${sep}`;

			if (config.reporters.length === 0) {
				config.reporters = [{ name: 'simple' }];
			}

			if (config.benchmarkConfig) {
				config.reporters.push({
					name: 'benchmark',
					options: config.benchmarkConfig
				});
			}

			this._instrumentBasePath = normalizePath(`${resolve(config.basePath || '')}${sep}`);

			if (!config.serverPort) {
				config.serverPort = 9000;
			}

			if (!config.socketPort) {
				config.socketPort = config.serverPort + 1;
			}

			if (!config.serverUrl) {
				config.serverUrl = 'http://localhost:' + config.serverPort;
			}

			config.serverUrl = config.serverUrl.replace(/\/*$/, '/');

			if (!config.capabilities.name) {
				config.capabilities.name = 'intern';
			}

			const buildId = process.env.TRAVIS_COMMIT || process.env.BUILD_TAG;
			if (buildId) {
				config.capabilities.build = buildId;
			}

			return ['suites', 'browserSuites', 'functionalSuites', 'nodeSuites'].forEach((property: keyof Config) => {
				config[property] = expandFiles(config[property]);
			});
		});
	}

	protected _runTests() {
		return super._runTests().then(() => {
			if (this._sessionSuites) {
				return this._loadFunctionalSuites()
					.then(() => this._runRemoteTests());
			}
		});
	}

	protected _runRemoteTests() {
		const config = this.config;
		const sessionSuites = this._sessionSuites;

		this.log('Running with maxConcurrency', config.maxConcurrency);

		const queue = new FunctionQueue(config.maxConcurrency || Infinity);
		const numSuitesToRun = sessionSuites.length;

		this.log('Running', numSuitesToRun, 'suites');

		// ...then run remote unit tests and functional tests
		return Task.all(sessionSuites.map(suite => {
			this.log('Queueing suite', suite.name);
			return queue.enqueue(() => {
				this.log('Running suite', suite.name);
				return suite.run();
			});
		})).finally(() => {
			if (config.functionalCoverage !== false) {
				// Collect any local coverage generated by functional tests
				this.log('Emitting coverage');
				return this._emitCoverage('functional tests');
			}
		}).finally(() => {
			// If coverageSources is set, generate initial coverage data for files with no coverage results
			const filesWithCoverage = this._coverageMap.files();
			expandFiles(this.config.coverageSources)
				.map(path => resolve(path))
				.filter(path => filesWithCoverage.indexOf(path) === -1)
				.forEach(filename => {
					const code = readFileSync(filename, { encoding: 'utf8' });
					const instrumentedCode = this.instrumentCode(code, filename);
					const coverage = readInitialCoverage(instrumentedCode);
					this._coverageMap.addFileCoverage(coverage.coverageData);
				});
		});
	}

	/**
	 * Adds hooks for code coverage instrumentation in the Node.js loader.
	 */
	protected _setInstrumentationHooks() {
		hookRunInThisContext(filename => this.shouldInstrumentFile(filename),
			(code, filename) => this.instrumentCode(code, filename));
		this._unhookRequire = hookRequire(filename => this.shouldInstrumentFile(filename),
			(code, filename) => this.instrumentCode(code, filename));
	}

	protected _removeInstrumentationHooks() {
		unhookRunInThisContext();
		if (this._unhookRequire) {
			this._unhookRequire();
			this._unhookRequire = null;
		}
	}
}

export interface Config extends BaseConfig {
	/** A loader used to load test suites and application modules in a remote browser. */
	browserLoader: LoaderDescriptor;

	browserPlugins: PluginDescriptor[];

	/**
	 * A list of paths to unit tests suite scripts (or some other suite identifier usable by the suite loader) that
	 * will only be loaded in remote browsers.
	 */
	browserSuites: string[];

	capabilities: {
		name?: string;
		build?: string;
		[key: string]: any;
	};

	/** Time to wait for contact from a remote server */
	connectTimeout: number;

	/**
	 * If set, coverage will be collected for all files. This allows uncovered files to be noticed more easily.
	 */
	coverageSources: string[];

	/** A list of remote environments */
	environments: EnvironmentSpec[];

	/** If true, collect coverage data from functional tests */
	functionalCoverage: boolean;

	functionalSuites: string[];

	leaveRemoteOpen: boolean | 'fail';
	maxConcurrency: number;

	/**
	 * A loader used to load test suites and application modules in a Node environment
	 */
	nodeLoader: LoaderDescriptor;

	/**
	 * Plugins that should only be loaded in a Node environment
	 */
	nodePlugins: PluginDescriptor[];

	/**
	 * A list of paths to unit tests suite scripts (or some other suite identifier usable by the suite loader) that
	 * will only be loaded in Node environments.
	 */
	nodeSuites: string[];

	serveOnly: boolean;
	serverPort: number;
	serverUrl: string;
	runInSync: boolean;
	socketPort?: number;
	tunnel: string;
	tunnelOptions?: TunnelOptions | BrowserStackOptions | SeleniumOptions;
}

export interface Remote extends Command<any> {
	environmentType?: Environment;
	setHeartbeatInterval(delay: number): Command<any>;
}

export interface EnvironmentSpec {
	browserName: string;
	[key: string]: any;
}

export interface TunnelMessage {
	tunnel: Tunnel;
	progress?: DownloadProgressEvent;
	status?: string;
}

export interface Events extends BaseEvents {
	/** A test server has stopped */
	serverEnd: Server;

	/** A test server was started */
	serverStart: Server;

	/** Emitted as a Tunnel executable download is in process */
	tunnelDownloadProgress: TunnelMessage;

	/** A WebDriver tunnel has been opened */
	tunnelStart: TunnelMessage;

	/** A status update from a WebDriver tunnel */
	tunnelStatus: TunnelMessage;

	/** A WebDriver tunnel has been stopped */
	tunnelStop: TunnelMessage;
}

/**
 * A basic FIFO function queue to limit the number of currently executing asynchronous functions.
 */
class FunctionQueue {
	readonly maxConcurrency: number;
	queue: QueueEntry[];
	activeTasks: Task<any>[];
	funcTasks: Task<any>[];

	constructor(maxConcurrency: number) {
		this.maxConcurrency = maxConcurrency;
		this.queue = [];
		this.activeTasks = [];
		this.funcTasks = [];
	}

	enqueue(func: () => Task<any>) {
		const funcTask = new Task((resolve, reject) => {
			this.queue.push({ func, resolve, reject });
		});
		this.funcTasks.push(funcTask);

		if (this.activeTasks.length < this.maxConcurrency) {
			this.next();
		}

		return funcTask;
	}

	clear() {
		this.activeTasks.forEach(task => task.cancel());
		this.funcTasks.forEach(task => task.cancel());
		this.activeTasks = [];
		this.funcTasks = [];
		this.queue = [];
	}

	next() {
		if (this.queue.length > 0) {
			const { func, resolve, reject } = this.queue.shift()!;
			const task = func().then(resolve, reject).finally(() => {
				// Remove the task from the active task list and kick off the next task
				pullFromArray(this.activeTasks, task);
				this.next();
			});
			this.activeTasks.push(task);
		}
	}
}

interface QueueEntry {
	func: () => Task<any>;
	resolve: () => void;
	reject: () => void;
}
