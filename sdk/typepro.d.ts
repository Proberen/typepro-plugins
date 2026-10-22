/**
 * TypePro Plugin API 3 public contract.
 * Runtime: isolated main.js Worker and package-owned UI frames both receive global `notebook`.
 * Permissions are checked by the host on every call. A TypeScript type is not an authorization grant.
 * This declaration has no runtime dependency on TypePro's application source.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
export type PluginPermission = "notes.read" | "notes.write" | "editor.read" | "editor.insert" | "commands" | "panels" | "ui" | "storage" | "network" | "secrets" | "files.pick" | "files.export";
export type PluginSlot = "home.widget" | "app.page" | "plugin.settings";
export type CommandLocation = "app.menu" | "home.toolbar" | "editor.toolbar";
export type PluginErrorCode = "PERMISSION_DENIED" | "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFLICT" | "CANCELLED" | "LIMIT_EXCEEDED" | "UNSUPPORTED_API" | "NETWORK_ERROR" | "INTERNAL_ERROR";
export interface PluginApiError extends Error { code: PluginErrorCode }
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 3;
  description?: string;
  permissions: PluginPermission[];
  /** Exact HTTPS origins; no wildcard, URL path, credentials, query or fragment. */
  networkOrigins?: string[];
}
export interface PluginPackage {
  manifest: PluginManifest;
  code: string;
  /** Relative resource keys under ZIP files/, e.g. ui.js and ui.css. */
  files?: Record<string, string>;
}
export interface Theme {mode: "light" | "dark"; accent: string}
export interface PluginContext {
  readonly pluginId: string;
  /** Namespaced view ID in a UI frame; null in a Worker. */
  readonly surfaceId: string | null;
  readonly slot: PluginSlot | null;
  readonly deviceId: string;
  readonly theme: Theme;
  readonly activeDocumentId: string | null;
}
export interface DocumentMetadata {id: string; title: string; updatedAt: string}
export interface NoteDocument extends DocumentMetadata {markdown: string}
export interface NotebookMetadata {id: string; name: string; documents: DocumentMetadata[]}
export interface SearchResult extends DocumentMetadata {notebookId: string; notebook: string; snippet: string}
export interface SearchPage {results: SearchResult[]; hasMore: boolean}
export interface StorageEntry {key: string; value: JsonValue}
export interface DocumentChange {
  documentId: string;
  title: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  /** Generic visible-text projections; plugins decide their own counting/filtering rules. */
  beforePlain?: string;
  afterPlain?: string;
  origin: "human" | "plugin" | "sync" | "import";
  history?: "undo" | "redo";
  timestamp: string;
  transactionId: string;
}
export interface PluginEventMap {
  "document.changed": DocumentChange;
  "document.active": {documentId: string | null};
  "storage.changed": {keys: string[] | null};
  "sync.completed": {timestamp: string};
  "theme.changed": Theme;
  "view.visibility": {visible: boolean};
}
export interface CallControl {signal?: AbortSignal}
export interface ViewRegistration {
  id: string;
  slot: PluginSlot;
  title: string;
  script: string;
  styles?: string[];
  /** home.widget only, clamped to 100–600px. */
  height?: number;
  icon?: string;
}
export interface CommandOptions {
  locations?: CommandLocation[];
  icon?: string;
  /** e.g. Mod+Shift+KeyK. Conflict rejects registration; retry without a shortcut. */
  shortcut?: string;
}
export interface NetworkRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  /** A device-local credential reference; no secret is returned to plugin code. */
  credential?: {id: string; header?: string; prefix?: string};
}
export interface NetworkResponse {status: number; headers: Record<string, string>; body: string}
export interface StreamResponse {status: number; headers: Record<string, string>}
export type NoteChangeProposal =
  | {notebookId: string; documentId?: never; title: string; markdown: string; expectedMarkdown?: never}
  | {documentId: string; notebookId?: never; title: string; markdown: string; expectedMarkdown: string};
export interface ReviewResult {applied: boolean; documentId?: string}
export interface PickedFile {name: string; bytes: number[]}

export interface TypeProSDK {
  readonly context: PluginContext;
  readonly notes: {
    list(): Promise<NotebookMetadata[]>;
    search(query: string, options?: {limit?: number; offset?: number}): Promise<SearchPage>;
    get(id: string): Promise<NoteDocument | null>;
    active(): Promise<NoteDocument | null>;
    open(id: string): Promise<void>;
    create(notebookId: string, title: string, markdown?: string): Promise<NoteDocument>;
    update(id: string, markdown: string, options?: {expectedMarkdown?: string}): Promise<void>;
  };
  readonly editor: {
    context(): Promise<DocumentMetadata | null>;
    selection(): Promise<{documentId: string | null; text: string}>;
    insert(text: string): Promise<void>;
    replaceSelection(text: string): Promise<void>;
  };
  readonly storage: {
    get(key: string): Promise<JsonValue | null>;
    list(prefix?: string): Promise<StorageEntry[]>;
    /** Own synchronized JSON namespace. Invalid/non-JSON values are rejected. */
    set(key: string, value: JsonValue): Promise<void>;
    remove(key: string): Promise<void>;
  };
  readonly commands: {
    register(id: string, label: string, callback: () => void | Promise<void>, options?: CommandOptions): Promise<void>;
  };
  readonly ui: {
    register(options: ViewRegistration): Promise<void>;
    open(id: string): Promise<void>;
    close(): Promise<void>;
    resize(height: number): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  readonly dialogs: {
    confirm(options: {title: string; message: string}, control?: CallControl): Promise<boolean>;
    /** Host reviews and applies this exact proposal; no separate writable approval token. */
    reviewChanges(proposal: NoteChangeProposal, control?: CallControl): Promise<ReviewResult>;
  };
  readonly notifications: {show(message: string): Promise<void>};
  readonly network: {
    authorize(origin: string): Promise<boolean>;
    request(request: NetworkRequest, control?: CallControl): Promise<NetworkResponse>;
    /** Chunks are raw UTF-8 text. Callback errors cancel the transport and reject the call. */
    stream(request: NetworkRequest, onChunk: (chunk: string) => void, control?: CallControl): Promise<StreamResponse>;
  };
  readonly secrets: {
    configure(id: string, options: {label?: string; origin: string}): Promise<{configured: boolean}>;
    status(id: string, options: {origin: string}): Promise<boolean>;
    remove(id: string): Promise<void>;
  };
  readonly files: {
    pick(options?: {extensions?: string[]}): Promise<PickedFile | null>;
    save(options: {name: string; bytes: number[]}): Promise<boolean>;
  };
  readonly panels: {
    set(id: string, title: string, text: string): Promise<void>;
    close(id: string): Promise<void>;
  };
  readonly events: {
    on<Name extends keyof PluginEventMap>(name: Name, callback: (event: PluginEventMap[Name]) => void | Promise<void>): Promise<() => Promise<void>>;
    /** Legacy convenience: active-document and document-change notifications with document ID only. */
    onDocumentChange(callback: (event: {documentId: string | null}) => void | Promise<void>): Promise<() => Promise<void>>;
  };
}

declare global {
  /** Injected by TypePro into this plugin's isolated runtime. */
  var notebook: TypeProSDK;
}
