// Types for owner-action.mjs, so the backend's unit test can check its payloads against the Lambda's schema.
export declare const WORKFLOW_ACTIONS: string[];
export declare function buildPayload(inputs: Record<string, unknown>, actor: string): { payload: Record<string, unknown> } | { errors: string[] };
