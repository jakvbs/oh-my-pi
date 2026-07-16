import { stateLifecycleJudge } from "./contract-state/state-lifecycle";
import { errorsHandlingJudge } from "./contract-state/errors-handling";
import { compatibilityFallbacksJudge } from "./contract-state/compatibility-fallbacks";
import { policyOwnershipJudge } from "./contract-state/policy-ownership";
import { languageContractJudge } from "./narrative-cognition/language-contract";
import { storyNavigationJudge } from "./narrative-cognition/story-navigation";
import { valuesFlowJudge } from "./narrative-cognition/values-flow";
import { interfacesOwnershipJudge } from "./modules-locality/interfaces-ownership";
import { seamsRepresentationJudge } from "./modules-locality/seams-representation";
import { changeProbesJudge } from "./modules-locality/change-probes";
import { scenarioDesignJudge } from "./tests-evidence/scenario-design";
import { executionSafetyJudge } from "./tests-evidence/execution-safety";
import { verdictProofJudge } from "./tests-evidence/verdict-proof";

export const judgeDefinitions = [
	stateLifecycleJudge,
	errorsHandlingJudge,
	compatibilityFallbacksJudge,
	policyOwnershipJudge,
	languageContractJudge,
	storyNavigationJudge,
	valuesFlowJudge,
	interfacesOwnershipJudge,
	seamsRepresentationJudge,
	changeProbesJudge,
	scenarioDesignJudge,
	executionSafetyJudge,
	verdictProofJudge,
] as const;

export const judgeDefinitionsById = new Map(judgeDefinitions.map(definition => [definition.id, definition]));
