import { YAML } from "bun";
import { z } from "zod";
import catalogYaml from "./guides/catalog.yaml" with { type: "text" };
import compatibilityFallbacks from "./guides/contract/compatibility-fallbacks.md" with { type: "text" };
import errorsHandling from "./guides/contract/errors-handling.md" with { type: "text" };
import policyOwnership from "./guides/contract/policy-ownership.md" with { type: "text" };
import stateLifecycle from "./guides/contract/state-lifecycle.md" with { type: "text" };
import core from "./guides/core.md" with { type: "text" };
import changeProbes from "./guides/modules/change-probes.md" with { type: "text" };
import interfacesLocality from "./guides/modules/interfaces-locality.md" with { type: "text" };
import seamsRepresentation from "./guides/modules/seams-representation.md" with { type: "text" };
import readability from "./guides/narrative/readability.md" with { type: "text" };
import valuesFlow from "./guides/narrative/values-flow.md" with { type: "text" };
import evidenceSafety from "./guides/tests/evidence-safety.md" with { type: "text" };
import scenarioDesign from "./guides/tests/scenario-design.md" with { type: "text" };

const staticGuideDocuments = [
	{ id: "contract/state-lifecycle", content: stateLifecycle },
	{ id: "contract/errors-handling", content: errorsHandling },
	{ id: "contract/compatibility-fallbacks", content: compatibilityFallbacks },
	{ id: "contract/policy-ownership", content: policyOwnership },
	{ id: "modules/interfaces-locality", content: interfacesLocality },
	{ id: "modules/seams-representation", content: seamsRepresentation },
	{ id: "modules/change-probes", content: changeProbes },
	{ id: "narrative/readability", content: readability },
	{ id: "narrative/values-flow", content: valuesFlow },
	{ id: "tests/scenario-design", content: scenarioDesign },
	{ id: "tests/evidence-safety", content: evidenceSafety },
] as const;

export type GuideId = (typeof staticGuideDocuments)[number]["id"];
export type GuideFamily = "contract" | "modules" | "narrative" | "tests";
export type GuideDocument = { id: GuideId; content: string };

const guideIdSchema = z.enum(staticGuideDocuments.map(document => document.id));

export function isGuideId(value: string): value is GuideId {
	return guideIdSchema.safeParse(value).success;
}
const guideFamilySchema = z.enum(["contract", "modules", "narrative", "tests"]);
const guideCatalogEntrySchema = z
	.object({
		id: guideIdSchema,
		family: guideFamilySchema,
		title: z.string().min(1),
		when_to_use: z.array(z.string().min(1)).min(1),
		not_for: z.array(z.string().min(1)).min(1),
		requires: z.array(z.string().min(1)),
		criteria: z.array(z.string().min(1)).min(1),
	})
	.strict();

const guideCatalogSchema = z
	.object({
		version: z.literal(1),
		guides: z.array(guideCatalogEntrySchema).length(11),
	})
	.strict()
	.superRefine((catalog, context) => {
		const ids = catalog.guides.map(guide => guide.id);
		if (new Set(ids).size !== ids.length) {
			context.addIssue({ code: "custom", message: "Guide ids must be globally unique", path: ["guides"] });
		}

		const families = new Set(catalog.guides.map(guide => guide.family));
		for (const family of guideFamilySchema.options) {
			if (!families.has(family)) {
				context.addIssue({ code: "custom", message: `Missing guide family: ${family}`, path: ["guides"] });
			}
		}

		const criteria = catalog.guides.flatMap(guide => guide.criteria);
		if (criteria.length !== 60) {
			context.addIssue({ code: "custom", message: "Catalog must contain 60 historical criteria", path: ["guides"] });
		}
		if (new Set(criteria).size !== criteria.length) {
			context.addIssue({ code: "custom", message: "Criterion ids must be globally unique", path: ["guides"] });
		}
	});

export type GuideCatalogEntry = z.infer<typeof guideCatalogEntrySchema>;
export type GuideCatalog = z.infer<typeof guideCatalogSchema>;

export const guideCatalog: GuideCatalog = guideCatalogSchema.parse(YAML.parse(catalogYaml));
export const plannerGuideCatalog: readonly GuideCatalogEntry[] = guideCatalog.guides;
export const coreGuide = core;
export const guideDocumentRegistry: readonly GuideDocument[] = staticGuideDocuments;

const catalogIds = new Set(guideCatalog.guides.map(guide => guide.id));
const documentIds = new Set(staticGuideDocuments.map(document => document.id));
if (
	catalogIds.size !== documentIds.size ||
	[...catalogIds].some(id => !documentIds.has(id)) ||
	[...documentIds].some(id => !catalogIds.has(id))
) {
	throw new Error("Static guide documents must exactly match catalog ids");
}

const guideDocumentsById = new Map<GuideId, string>(
	staticGuideDocuments.map(document => [document.id, document.content] as const),
);

export function guideDocumentsFor(guideIds: readonly GuideId[]): GuideDocument[] {
	return guideIds.map(id => {
		const content = guideDocumentsById.get(id);
		if (content === undefined) throw new Error(`Missing static guide document: ${id}`);
		return { id, content };
	});
}
