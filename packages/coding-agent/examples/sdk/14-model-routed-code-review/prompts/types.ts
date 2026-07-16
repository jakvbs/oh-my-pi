export type JudgeType = "contract-state" | "narrative-cognition" | "modules-locality" | "tests-evidence";

export type JudgeDefinition = {
	id: string;
	judgeType: JudgeType;
	rubricVersion: string;
	criterionIds: readonly string[];
	prompt: string;
};
