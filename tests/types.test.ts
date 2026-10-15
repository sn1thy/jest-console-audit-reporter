import { AuditConfig, AuditRule, DisplayOptions, AuditReport } from '../dist/types';
import { wrapEnvironment } from '../dist/environments/factory';
const rule: AuditRule = {id:'expected',label:'Expected',reason:'Intentional',levels:['warn'],match:{regex:{source:'warning',flags:'i'}}};
const display: DisplayOptions = {detail:'detailed',githubActions:'auto'};
const config: AuditConfig = {schemaVersion:1,rules:[rule],display};
declare const report: AuditReport;
const origin: string | undefined = report.totals.groups[0].samples[0].origin;
class Base { constructor(config: unknown, context: unknown) {} custom(): number {return 42;} async teardown(): Promise<void> {} }
const Wrapped = wrapEnvironment(Base);
const instance: Base = new Wrapped(config, {});
const custom: number = instance.custom();
void origin; void custom;
