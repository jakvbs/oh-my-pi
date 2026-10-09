import { Process } from "@oh-my-pi/pi-natives";
import type { Socket } from "bun";

interface CdpProbeResponse {
	status: number;
	body: string;
}

interface RawGetOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Resolve after the body arrives (Content-Length or peer close) instead of on the status line. */
	readBody: boolean;
}

/**
 * Loopback HTTP/1.1 GET that never routes through a proxy. Resolves null when
 * the endpoint is unreachable, aborted, malformed, or slow past `timeoutMs`.
 *
 * Chrome's DevTools endpoint listens on loopback and speaks plain HTTP/1.1.
 * Both `fetch` and Bun's `node:http` honor `HTTP_PROXY`/`HTTPS_PROXY` and
 * forward even `127.0.0.1` requests to the proxy unless `NO_PROXY` covers them,
 * so a local proxy that 502s internal addresses makes a healthy daemon look
 * dead and the CDP readiness checks tear it down (issue #8567). Talking to the
 * socket over raw TCP sidesteps proxy env entirely.
 */
async function rawHttpGet(url: string, opts: RawGetOptions): Promise<CdpProbeResponse | null> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	if (opts.signal?.aborted) return null;
	const port = target.port ? Number(target.port) : 80;
	const requestPath = `${target.pathname}${target.search}` || "/";
	const { promise, resolve } = Promise.withResolvers<CdpProbeResponse | null>();
	let socket: Socket<undefined> | undefined;
	let settled = false;
	const finish = (response: CdpProbeResponse | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		try {
			socket?.end();
		} catch {
			// socket already torn down
		}
		resolve(response);
	};
	const onAbort = () => finish(null);
	const timer = setTimeout(() => finish(null), opts.timeoutMs);
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	let buffered = "";
	let status: number | null = null;
	// Offset of the header/body separator once the header block is complete.
	let headerEnd = -1;
	let contentLength: number | null = null;
	const bodySoFar = () => buffered.slice(headerEnd + 4);
	try {
		socket = await Bun.connect({
			hostname: target.hostname,
			port,
			socket: {
				open(s) {
					s.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\nConnection: close\r\n\r\n`);
				},
				data(_s, chunk) {
					buffered += chunk.toString("latin1");
					if (status === null) {
						const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buffered);
						if (!match) return;
						status = Number(match[1]);
						if (!opts.readBody) {
							finish({ status, body: "" });
							return;
						}
					}
					if (headerEnd === -1) {
						headerEnd = buffered.indexOf("\r\n\r\n");
						if (headerEnd === -1) return;
						const lengthHeader = /\r\ncontent-length:\s*(\d+)/i.exec(buffered.slice(0, headerEnd));
						contentLength = lengthHeader ? Number(lengthHeader[1]) : null;
					}
					if (contentLength !== null && bodySoFar().length >= contentLength) {
						finish({ status, body: bodySoFar().slice(0, contentLength) });
					}
				},
				error() {
					finish(null);
				},
				close() {
					// Without Content-Length the peer's close delimits the body.
					finish(status !== null && headerEnd !== -1 ? { status, body: bodySoFar() } : null);
				},
			},
		});
	} catch {
		finish(null);
	}
	return promise;
}

/**
 * Proxy-proof loopback probe resolving to the response status code, or null
 * when the endpoint is unreachable, aborted, malformed, or slow past `timeoutMs`.
 */
export async function probeCdpStatus(
	url: string,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<number | null> {
	const response = await rawHttpGet(url, { ...opts, readBody: false });
	return response?.status ?? null;
}

/**
 * SIGTERM the process tree, wait briefly, then SIGKILL anything still alive.
 * Single-process variant for our own spawned children.
 */
export async function gracefulKillTreeOnce(pid: number, gracePeriodMs = 2000): Promise<void> {
	const process = Process.fromPid(pid);
	if (!process) return;
	await process.terminate({ gracefulMs: gracePeriodMs, timeoutMs: 500 });
}
