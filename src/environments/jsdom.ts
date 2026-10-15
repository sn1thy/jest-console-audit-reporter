import { wrapEnvironment } from "./factory";
const base = require("jest-environment-jsdom");
export = wrapEnvironment(base.TestEnvironment || base.default || base);
