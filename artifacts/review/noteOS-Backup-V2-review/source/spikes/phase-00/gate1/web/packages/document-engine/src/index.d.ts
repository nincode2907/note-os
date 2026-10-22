export type CanonicalDocumentV1 = {
  schemaVersion: 1;
  type: 'doc';
  content: Array<Record<string, unknown>>;
};

export type ValidationIssue = { code: string; path: string; message: string };
export type ValidationResult =
  | { status: 'supported'; editable: true; document: CanonicalDocumentV1; issues: [] }
  | { status: 'invalid' | 'unsupported'; editable: false; issues: ValidationIssue[] };

export const CANONICAL_SCHEMA_VERSION: 1;
export const CANONICAL_DOCUMENT_TYPE: 'doc';
export function createDocumentExtensions(): unknown[];
export function getCanonicalSchema(): unknown;
export function createEmptyCanonicalDocument(): CanonicalDocumentV1;
export function plainTextToCanonicalDocument(text: string): CanonicalDocumentV1;
export function validateCanonicalDocument(input: unknown, schema?: unknown): ValidationResult;
export function parseCanonicalDocument(jsonText: string, schema?: unknown): ValidationResult;
export function serializeCanonicalDocument(input: unknown, schema?: unknown): { status: string; json: string | null; document?: CanonicalDocumentV1; validation?: ValidationResult };
export function canonicalDocumentFromTiptapJSON(input: unknown, schema?: unknown): ValidationResult;
export function toTiptapJSON(input: unknown, schema?: unknown): { status: string; json: Record<string, unknown> | null; document?: CanonicalDocumentV1; validation?: ValidationResult };
export function canonicalToPlainText(input: unknown, schema?: unknown): { status: string; text: string | null; warnings: Array<Record<string, string>>; validation?: ValidationResult };
export function canonicalToMarkdown(input: unknown, schema?: unknown): { status: string; markdown: string | null; warnings: Array<Record<string, string>>; validation?: ValidationResult };
export function createTiptapEditor(options: { element?: HTMLElement | null; document: unknown; editable?: boolean; onUpdate?: (document: CanonicalDocumentV1) => void }): unknown;
