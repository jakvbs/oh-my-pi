import { describe, expect, test } from "bun:test";
import {
	coreGuide,
	guideCatalog,
	guideDocumentRegistry,
	guideDocumentsFor,
	plannerGuideCatalog,
} from "./guide-catalog";

const historicalCriteria = [
	"STATE-01",
	"STATE-02",
	"STATE-03",
	"STATE-04",
	"STATE-05",
	"ERROR-01",
	"ERROR-02",
	"ERROR-03",
	"COMPAT-01",
	"COMPAT-02",
	"FALLBACK-01",
	"FALLBACK-02",
	"FALLBACK-03",
	"OWNER-01",
	"OWNER-02",
	"OWNER-03",
	"OWNER-04",
	"MOD-INTERFACE-KNOWLEDGE",
	"MOD-DELETION-DEPTH",
	"MOD-LEVERAGE",
	"MOD-CHANGE-LOCALITY",
	"MOD-POLICY-OWNERSHIP",
	"MOD-SAME-OPERATION-LAYERING",
	"MOD-CALLER-BEHAVIOR",
	"SEAM-REAL-VARIATION",
	"ADAPTER-BOUNDARY-ISOLATION",
	"DATA-CANONICAL-REPRESENTATION",
	"DATA-VALUE-OBJECT-INVARIANT",
	"ABSTRACTION-CALLER-KNOWLEDGE",
	"ABSTRACTION-SHARED-CONTRACT",
	"PROBE-POLICY-CHANGE",
	"PROBE-STATE-VARIANT",
	"PROBE-VENDOR-CHANGE",
	"PROBE-DOMAIN-SCENARIO",
	"LANG-1",
	"LANG-2",
	"LANG-3",
	"NARR-1A",
	"NARR-1B",
	"NARR-2",
	"NARR-3",
	"NARR-4",
	"NARR-5",
	"COG-1",
	"COG-2A",
	"COG-2B",
	"FLOW-1",
	"METRIC-1",
	"TEST-BOUNDARY",
	"TEST-SCENARIO-LINEARITY",
	"TEST-COLLABORATOR-CHOICE",
	"TEST-DOUBLE-CONTRACT",
	"TEST-PROTOCOL-ASSERTIONS",
	"TEST-DETERMINISM",
	"TEST-ISOLATION",
	"TEST-RESOURCE-CLEANUP",
	"TEST-FULL-SUITE-SAFETY",
	"TEST-VERDICT-COVERAGE",
	"TEST-RUNNABLE-PROOF",
	"TEST-BUG-BEFORE-AFTER",
] as const;

describe("guide catalog", () => {
	test("owns eleven selectable guides, four families, and all sixty historical criteria", () => {
		expect(guideCatalog.version).toBe(1);
		expect(guideCatalog.guides).toHaveLength(11);
		expect(plannerGuideCatalog).toEqual(guideCatalog.guides);

		const ids = guideCatalog.guides.map(guide => guide.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(guideCatalog.guides.map(guide => guide.family))).toEqual(
			new Set(["contract", "modules", "narrative", "tests"]),
		);

		const criteria = guideCatalog.guides.flatMap(guide => guide.criteria);
		expect(criteria).toHaveLength(60);
		expect(new Set(criteria).size).toBe(criteria.length);
		expect(new Set(criteria)).toEqual(new Set(historicalCriteria));
	});

	test("keeps static documents in exact catalog ownership order", () => {
		expect(guideDocumentRegistry.map(document => document.id)).toEqual(guideCatalog.guides.map(guide => guide.id));

		for (const document of guideDocumentRegistry) {
			const catalogEntry = guideCatalog.guides.find(guide => guide.id === document.id);
			expect(catalogEntry).toBeDefined();
			if (!catalogEntry) throw new Error(`Missing catalog entry for ${document.id}`);
			const headingCriteria = [...document.content.matchAll(/^### ([A-Z0-9-]+) —/gm)].map(match => match[1]);
			expect(headingCriteria).toEqual(catalogEntry.criteria);
		}
	});

	test("keeps core implicit and requires an explicit change probe", () => {
		expect(coreGuide).toContain("# Core review contract");
		expect(guideCatalog.guides.map(guide => guide.id)).not.toContain("core");
		const changeProbes = guideCatalog.guides.find(guide => guide.id === "modules/change-probes");
		expect(changeProbes?.requires).toEqual(["explicit change probe in the review request or allowed source"]);
	});

	test("keeps request-only change probes and simulations out of source evidence", () => {
		const [document] = guideDocumentsFor(["modules/change-probes"]);
		expect(document).toBeDefined();
		if (!document) throw new Error("Missing change-probes guide");

		const checks = document.content.split(/^### /m).slice(1);
		expect(checks).toHaveLength(4);
		for (const check of checks) {
			const evidenceClause = check
				.split("\n")
				.find(line => line.startsWith("- Evidence MUST"))
				?.split(". Put")[0];
			expect(evidenceClause).toBeDefined();
			expect(evidenceClause).not.toMatch(/simulat|probe text|scenario text/i);
			expect(check).toContain("Put the supplied");
			expect(check).toContain("in `reason`");
		}
	});
});
