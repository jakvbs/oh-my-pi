/**
 * AgentRegistry - Process-global registry of live agent sessions, keyed by
 * stable id.
 *
 * Internal-URL handlers use it to find the session whose artifacts directory
 * or working directory applies when the caller supplies no session context.
 * Sessions are registered at creation and removed on teardown.
 */

import type { AgentSession } from "../session/agent-session";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
export { MAIN_AGENT_ID };

export interface AgentRef {
	id: string;
	session: AgentSession | null;
	sessionFile: string | null;
}

export type AgentRefExpectation = AgentRef | AgentSession;

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

	register(input: { id: string; session: AgentSession | null; sessionFile?: string | null }): AgentRef {
		const ref: AgentRef = { id: input.id, session: input.session, sessionFile: input.sessionFile ?? null };
		this.#refs.set(ref.id, ref);
		return ref;
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		this.#refs.delete(id);
		return true;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}
}
