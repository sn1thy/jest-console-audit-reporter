import { wrapEnvironment } from "./factory";
const base = require("jest-environment-node");
export = wrapEnvironment(base.TestEnvironment || base.default || base);
