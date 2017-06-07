import Reporter, { ReporterProperties } from './Reporter';
import { CoverageMap, createCoverageMap } from 'istanbul-lib-coverage';
import { createContext, summarizers, Watermarks } from 'istanbul-lib-report';
import { create, ReportType } from 'istanbul-reports';
import { createEventHandler } from './Reporter';
import Node, { Events } from '../executors/Node';
import { mixin } from '@dojo/core/lang';

const eventHandler = createEventHandler<Events>();

export default abstract class Coverage<V extends CoverageOptions = CoverageOptions> extends Reporter<Node, CoverageOptions> implements CoverageProperties {
	readonly reportType: ReportType = 'text';

	executor: Node;

	filename: string;

	watermarks: Watermarks;

	constructor(executor: Node, config: V = <V>{}) {
		super(executor, mixin({}, config));
	}

	createCoverageReport(type: ReportType, data: object | CoverageMap) {
		let map: CoverageMap;

		if (isCoverageMap(data)) {
			map = data;
		}
		else {
			map = createCoverageMap(data);
		}

		const transformed = this.executor.sourceMapStore.transformCoverage(map).map;

		const context = createContext();
		const tree = summarizers.pkg(transformed);
		tree.visit(create(type, {
			file: this.filename,
			watermarks: this.watermarks
		}), context);
	}

	@eventHandler()
	runEnd(): void {
		this.createCoverageReport(this.reportType, this.executor.coverageMap);
	}
}

export interface CoverageProperties extends ReporterProperties {
	/** A filename to write coverage data to */
	filename: string | undefined;

	/** Watermarks used to check coverage */
	watermarks: Watermarks | undefined;
}

export type CoverageOptions = Partial<CoverageProperties>;

function isCoverageMap(value: any): value is CoverageMap {
	return value != null && typeof value.files === 'function';
}