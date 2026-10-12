import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/** Whether disabling tools requires a history without prior tool calls or results. */
export function requiresToolFreeHistoryForToolOptOut(model: Model): boolean {
	return resolveCatalogPolicy(model).requiresToolFreeHistoryForToolOptOut === true;
}
