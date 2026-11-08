/**
 * Shapes of an ACP (Agent Client Protocol) permission request as the server
 * forwards it to the UI.
 *
 * The server normalizes the agent's `session/request_permission` params before
 * they leave the process (`packages/web/server/lib/acp/acp-protocol.js`), so the
 * UI never has to defend against a malformed option list — but the types stay
 * permissive about `kind`, because the protocol calls it a UI hint and lets an
 * agent send one this client does not know. An unknown kind is never consent:
 * only `allow_once` / `allow_always` are, and nothing here approves on its own.
 */

/** The four kinds ACP v1 defines. A live agent may still send something else. */
export const ACP_PERMISSION_OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;

export type AcpPermissionOptionKind = (typeof ACP_PERMISSION_OPTION_KINDS)[number];

export type AcpPermissionOption = {
    optionId: string;
    name: string;
    kind: string;
    /** True only for `allow_once` / `allow_always`; an unknown kind is never consent. */
    consent?: boolean;
};

/** The tool call the agent proposes, as far as the prompt shows it. */
export type AcpToolCall = {
    toolCallId?: string;
    title?: string;
    name?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    locations?: Array<{ path?: string; line?: number | null }>;
    content?: unknown[];
};

/** One pending prompt: the request the agent is blocked on. */
export type AcpPermissionRequest = {
    requestId: string;
    sessionID: string;
    /** The OpenChamber session's title when the request arrived, so the panel can name it. */
    title?: string;
    agent?: string;
    toolCall?: AcpToolCall;
    options?: AcpPermissionOption[];
};

/** True for the two kinds that constitute consent. */
export const isAcpConsentOptionKind = (kind: string | undefined): boolean => (
    kind === 'allow_once' || kind === 'allow_always'
);

/** True for the two reject kinds. */
export const isAcpRejectOptionKind = (kind: string | undefined): boolean => (
    kind === 'reject_once' || kind === 'reject_always'
);
