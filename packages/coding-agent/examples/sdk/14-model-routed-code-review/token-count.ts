import { countTokens } from "@oh-my-pi/pi-natives";

export function countTextTokens(value: string | string[]) {
	return countTokens(value);
}
