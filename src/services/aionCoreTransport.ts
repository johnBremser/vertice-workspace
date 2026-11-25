/**
 * @license
 * Single-flight session refresh coalescing pattern adapted from:
 * AionUi/packages/desktop/src/common/adapter/sessionRefresh.ts
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for Aion Desk: injectable fetch/cookie/WebSocket transport with real
 * `aionui-csrf-token` double-submit header support and strict error typing.
 */

import { GatewayCapabilityError } from './gateway';
import {
  assertWebSocketMessage,
  type ErrorResponse,
  type WebSocketMessage,
  type WsTokenResponse,
} from './aionCoreDtos';
import type { CoreDiagnosticsLog } from './coreDiagnostics';

export const WS_CLOSE_POLICY_VIOLATION = 1008;
export const CSRF_COOKIE_NAME = 'aionui-csrf-token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_EXEMPT_PATHS = new Set(['/login', '/api/auth/qr-login']);
const AUTH_NO_REFRESH_PATHS = new Set([
  '/login',
  '/logout',
  '/api/auth/refresh',
  '/api/auth/qr-login',
]);

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface WsLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
  url: string,
  protocols?: string | string[],
) => WsLike;

export interface AionCoreTransportOptions {
  baseUrl?: string;
  fetchFn?: FetchLike;
  wsFactory?: WebSocketFactory;
  readCookie?: (name: string) => string | undefined;
  timeoutMs?: number;
  diagnostics?: CoreDiagnosticsLog;
}

export function normalizeBaseUrl(rawUrl?: string): string {
  const envUrl =
    typeof import.meta !== 'undefined' &&
    typeof (import.meta as { env?: Record<string, string | undefined> }).env
      ?.VITE_AIONCORE_BASE_URL === 'string'
      ? (import.meta as { env: Record<string, string | undefined> }).env
          .VITE_AIONCORE_BASE_URL
      : '';
  const candidate = (rawUrl ?? envUrl ?? '').trim();
  if (!candidate) return '';
  return candidate.replace(/\/+$/, '');
}

export function buildWsUrlFromBase(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    if (typeof window !== 'undefined' && window.location?.host) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws`;
    }
    return 'ws://127.0.0.1/ws';
  }
  if (normalized.startsWith('https://')) {
    return `${normalized.replace(/^https:\/\//, 'wss://')}/ws`;
  }
  if (normalized.startsWith('http://')) {
    return `${normalized.replace(/^http:\/\//, 'ws://')}/ws`;
  }
  return `${normalized}/ws`;
}

export function defaultReadCookie(name: string): string | undefined {
  if (typeof document === 'undefined' || !document.cookie) return undefined;
  for (const part of document.cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      const val = part.slice(idx + 1).trim();
      return val || undefined;
    }
  }
  return undefined;
}

export class AionCoreHttpClient {
  private baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly readCookie: (name: string) => string | undefined;
  private readonly timeoutMs: number;
  private readonly diagnostics?: CoreDiagnosticsLog;
  private refreshInFlight: Promise<boolean> | null = null;
  private bearerToken: string | undefined;

  constructor(options: AionCoreTransportOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchFn =
      options.fetchFn ??
      ((input, init) => {
        if (typeof fetch !== 'function') {
          throw new GatewayCapabilityError(
            'NOT_CONNECTED_LOCAL_CORE',
            'API fetch indisponível neste ambiente.',
            true,
          );
        }
        return fetch(input, init);
      });
    this.readCookie = options.readCookie ?? defaultReadCookie;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.diagnostics = options.diagnostics;
  }

  setBaseUrl(nextBaseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(nextBaseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBearerToken(token?: string): void {
    this.bearerToken = token;
  }

  hasBearerToken(): boolean {
    return Boolean(this.bearerToken);
  }

  resolveCsrfToken(): string | undefined {
    return this.readCookie(CSRF_COOKIE_NAME);
  }

  async refreshSession(): Promise<boolean> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<boolean> {
    const path = '/api/auth/refresh';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const csrf = this.resolveCsrfToken();
    if (csrf) {
      headers[CSRF_HEADER_NAME] = csrf;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ token: this.bearerToken ?? '' }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.diagnostics?.record({
          operation: 'auth.refresh',
          status: 'error',
          code: 'AUTH_REQUIRED',
          httpStatus: response.status,
          detail: 'Falha ao renovar sessão expirada no Core.',
        });
        return false;
      }
      const data = (await response.json().catch(() => null)) as {
        token?: string;
      } | null;
      if (data && typeof data.token === 'string' && data.token) {
        this.bearerToken = data.token;
      }
      this.diagnostics?.record({
        operation: 'auth.refresh',
        status: 'ok',
        httpStatus: response.status,
        detail: 'Sessão renovada com sucesso via /api/auth/refresh.',
      });
      return true;
    } catch {
      this.diagnostics?.record({
        operation: 'auth.refresh',
        status: 'error',
        code: 'NOT_CONNECTED_LOCAL_CORE',
        detail: 'Erro de rede ao tentar renovar sessão no Core.',
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async requestJson<T>(input: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    idempotent?: boolean;
    timeoutMs?: number;
    operationName?: string;
    teamId?: string;
    slotId?: string;
  }): Promise<T> {
    const headers: Record<string, string> = {};
    if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return this.executeRequest<T>({
      method: input.method,
      path: input.path,
      headers,
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      timeoutMs: input.timeoutMs,
      operationName: input.operationName,
      teamId: input.teamId,
      slotId: input.slotId,
    });
  }

  /**
   * Sends a multipart/form-data POST request without forcing Content-Type so the runtime
   * supplies the multipart boundary automatically while preserving auth/CSRF handling.
   */
  async requestMultipart<T>(input: {
    path: string;
    formData: FormData;
    timeoutMs?: number;
    operationName?: string;
    teamId?: string;
    slotId?: string;
  }): Promise<T> {
    return this.executeRequest<T>({
      method: 'POST',
      path: input.path,
      body: input.formData,
      timeoutMs: input.timeoutMs,
      operationName: input.operationName,
      teamId: input.teamId,
      slotId: input.slotId,
    });
  }

  private async executeRequest<T>(input: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    timeoutMs?: number;
    operationName?: string;
    teamId?: string;
    slotId?: string;
  }): Promise<T> {
    const operation = input.operationName ?? `${input.method} ${input.path}`;
    const performAttempt = async (): Promise<Response> => {
      const headers: Record<string, string> = { ...(input.headers ?? {}) };
      if (this.bearerToken) {
        headers['Authorization'] = `Bearer ${this.bearerToken}`;
      }
      if (
        MUTATING_METHODS.has(input.method) &&
        !CSRF_EXEMPT_PATHS.has(input.path)
      ) {
        const csrf = this.resolveCsrfToken();
        if (csrf) {
          headers[CSRF_HEADER_NAME] = csrf;
        }
      }

      const controller = new AbortController();
      const timeoutMs = input.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await this.fetchFn(`${this.baseUrl}${input.path}`, {
          method: input.method,
          credentials: 'include',
          headers,
          body: input.body,
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.diagnostics?.record({
            operation,
            status: 'error',
            code: 'TIMEOUT',
            teamId: input.teamId,
            slotId: input.slotId,
            detail: `Tempo esgotado (${timeoutMs}ms) ao chamar ${input.path}.`,
          });
          throw new GatewayCapabilityError(
            'TIMEOUT',
            `Tempo limite excedido ao aguardar resposta do Core em ${input.path}.`,
            true,
          );
        }
        if (
          err instanceof Error &&
          err.name === 'AbortError'
        ) {
          this.diagnostics?.record({
            operation,
            status: 'error',
            code: 'TIMEOUT',
            teamId: input.teamId,
            slotId: input.slotId,
            detail: `Requisição abortada por timeout em ${input.path}.`,
          });
          throw new GatewayCapabilityError(
            'TIMEOUT',
            `Tempo limite excedido ao aguardar resposta do Core em ${input.path}.`,
            true,
          );
        }
        const msg = err instanceof Error ? err.message : 'Falha de rede';
        this.diagnostics?.record({
          operation,
          status: 'error',
          code: 'NOT_CONNECTED_LOCAL_CORE',
          teamId: input.teamId,
          slotId: input.slotId,
          detail: `Core inacessível em ${input.path}: ${msg}`,
        });
        throw new GatewayCapabilityError(
          'NOT_CONNECTED_LOCAL_CORE',
          `Não foi possível alcançar o AionCore em "${this.baseUrl || 'mesma origem'}" (${input.path}). Verifique se o servidor está em execução e o endereço configurado.`,
          true,
        );
      } finally {
        clearTimeout(timer);
      }
    };

    let response = await performAttempt();

    // Replay at most once after single-flight refresh only on deterministic 401 auth rejection
    // (never on timeout/ambiguous network errors and never on auth routes themselves).
    if (
      response.status === 401 &&
      !AUTH_NO_REFRESH_PATHS.has(input.path)
    ) {
      const refreshed = await this.refreshSession();
      if (refreshed) {
        response = await performAttempt();
      }
    }

    if (!response.ok) {
      const rawText = await response.text().catch(() => '');
      let errorPayload: Partial<ErrorResponse> | null = null;
      try {
        errorPayload = JSON.parse(rawText) as Partial<ErrorResponse>;
      } catch {
        errorPayload = null;
      }
      const backendCode =
        errorPayload && typeof errorPayload.code === 'string'
          ? errorPayload.code
          : '';
      const backendMessage =
        errorPayload && typeof errorPayload.error === 'string'
          ? errorPayload.error
          : rawText || response.statusText || `HTTP ${response.status}`;

      if (response.status === 401) {
        this.diagnostics?.record({
          operation,
          status: 'error',
          code: 'AUTH_REQUIRED',
          httpStatus: 401,
          teamId: input.teamId,
          slotId: input.slotId,
          detail: `Autenticação exigida ou expirada em ${input.path}.`,
        });
        throw new GatewayCapabilityError(
          'AUTH_REQUIRED',
          `Autenticação necessária ou sessão expirada no Core (${backendMessage}). Faça login novamente.`,
          true,
          401,
        );
      }

      if (
        response.status === 403 &&
        (backendCode.toUpperCase().includes('CSRF') ||
          backendMessage.toLowerCase().includes('csrf'))
      ) {
        this.diagnostics?.record({
          operation,
          status: 'error',
          code: 'CSRF_REJECTED',
          httpStatus: 403,
          teamId: input.teamId,
          slotId: input.slotId,
          detail: `Validação CSRF rejeitada em ${input.path}.`,
        });
        throw new GatewayCapabilityError(
          'CSRF_REJECTED',
          `Proteção CSRF rejeitou a requisição (${backendMessage}). Confira origem/proxy e cookie aionui-csrf-token.`,
          true,
          403,
        );
      }

      this.diagnostics?.record({
        operation,
        status: 'error',
        code: backendCode || 'OPERATION_FAILED',
        httpStatus: response.status,
        teamId: input.teamId,
        slotId: input.slotId,
        detail: `Erro HTTP ${response.status} em ${input.path}: ${backendMessage}`,
      });
      throw new GatewayCapabilityError(
        response.status === 400 || response.status === 422
          ? 'VALIDATION_ERROR'
          : 'OPERATION_FAILED',
        `Core retornou HTTP ${response.status}: ${backendMessage}`,
        true,
        response.status,
      );
    }

    const rawBody = await response.text().catch(() => '');
    if (!rawBody.trim()) {
      return undefined as T;
    }
    try {
      const parsed = JSON.parse(rawBody) as T;
      this.diagnostics?.record({
        operation,
        status: 'ok',
        httpStatus: response.status,
        teamId: input.teamId,
        slotId: input.slotId,
        detail: `Chamada ${input.method} ${input.path} concluída.`,
      });
      return parsed;
    } catch {
      this.diagnostics?.record({
        operation,
        status: 'error',
        code: 'INVALID_PAYLOAD',
        httpStatus: response.status,
        teamId: input.teamId,
        slotId: input.slotId,
        detail: `JSON inválido retornado por ${input.path}.`,
      });
      throw new GatewayCapabilityError(
        'INVALID_PAYLOAD',
        `Resposta não é um JSON válido em ${input.path}.`,
        true,
        response.status,
      );
    }
  }
}

export interface AionCoreWsCallbacks {
  onMessage: (message: WebSocketMessage) => void;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected' | 'error', detail?: string) => void;
}

export class AionCoreWsClient {
  private readonly httpClient: AionCoreHttpClient;
  private readonly wsFactory: WebSocketFactory;
  private readonly diagnostics?: CoreDiagnosticsLog;
  private ws: WsLike | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;
  private callbacks: AionCoreWsCallbacks | null = null;

  constructor(
    httpClient: AionCoreHttpClient,
    options: { wsFactory?: WebSocketFactory; diagnostics?: CoreDiagnosticsLog } = {},
  ) {
    this.httpClient = httpClient;
    this.wsFactory =
      options.wsFactory ??
      ((url, protocols) => {
        if (typeof WebSocket === 'undefined') {
          throw new GatewayCapabilityError(
            'CAPABILITY_UNSUPPORTED',
            'WebSocket indisponível neste ambiente.',
            true,
          );
        }
        return new WebSocket(url, protocols) as unknown as WsLike;
      });
    this.diagnostics = options.diagnostics;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  async connect(callbacks: AionCoreWsCallbacks): Promise<void> {
    this.manuallyClosed = false;
    this.callbacks = callbacks;
    this.clearReconnectTimer();
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    this.callbacks?.onStatusChange?.('connecting');
    let wsToken: string | undefined;
    try {
      const tokenResp = await this.httpClient.requestJson<WsTokenResponse>({
        method: 'GET',
        path: '/api/ws-token',
        idempotent: true,
        operationName: 'ws.token',
      });
      if (tokenResp && typeof tokenResp.ws_token === 'string' && tokenResp.ws_token) {
        wsToken = tokenResp.ws_token;
      }
    } catch (err) {
      this.callbacks?.onStatusChange?.(
        'error',
        err instanceof Error ? err.message : 'Falha ao obter token WS',
      );
      throw err;
    }

    const wsUrl = buildWsUrlFromBase(this.httpClient.getBaseUrl());
    // According to AionCore extract_token_from_ws_headers:
    // Sec-WebSocket-Protocol carries `<token>` as first element when cookie/auth headers are absent.
    const socket = wsToken
      ? this.wsFactory(wsUrl, [wsToken])
      : this.wsFactory(wsUrl);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.diagnostics?.record({
        operation: 'ws.connect',
        status: 'ok',
        detail: `WebSocket conectado em ${wsUrl}.`,
      });
      this.callbacks?.onStatusChange?.('connected');
    };

    socket.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
      try {
        const parsed = JSON.parse(raw) as unknown;
        const msg = assertWebSocketMessage(parsed);
        if (msg.name === 'ping') {
          try {
            socket.send(
              JSON.stringify({
                name: 'pong',
                data: msg.data ?? { timestamp: Date.now() },
              }),
            );
          } catch {
            // Ignore send error if socket is already closing
          }
          return;
        }
        this.callbacks?.onMessage(msg);
      } catch (err) {
        this.diagnostics?.record({
          operation: 'ws.message',
          status: 'error',
          code: 'INVALID_PAYLOAD',
          detail:
            err instanceof Error
              ? err.message
              : 'Falha ao interpretar mensagem WebSocket.',
        });
      }
    };

    socket.onerror = () => {
      this.diagnostics?.record({
        operation: 'ws.error',
        status: 'error',
        code: 'NOT_CONNECTED_LOCAL_CORE',
        detail: 'Erro no canal WebSocket do Core.',
      });
    };

    socket.onclose = (ev) => {
      this.ws = null;
      if (this.manuallyClosed) {
        this.callbacks?.onStatusChange?.('disconnected', 'Encerrado pelo usuário.');
        return;
      }
      this.diagnostics?.record({
        operation: 'ws.close',
        status: 'error',
        code: String(ev.code || 1006),
        detail: `WebSocket fechado (código ${ev.code || 1006}).`,
      });
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.callbacks?.onStatusChange?.(
          'error',
          'Limite de reconexões WebSocket atingido. Verifique sessão e conexão com o Core.',
        );
        return;
      }

      const attempt = this.reconnectAttempts;
      this.reconnectAttempts += 1;
      const delayMs = Math.min(4000, 400 * 2 ** attempt);

      this.callbacks?.onStatusChange?.(
        'disconnected',
        `Conexão WebSocket encerrada (${ev.code}). Tentando reconexão (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
      );

      this.reconnectTimer = setTimeout(() => {
        void (async () => {
          if (ev.code === WS_CLOSE_POLICY_VIOLATION) {
            const refreshed = await this.httpClient.refreshSession();
            if (!refreshed) {
              this.callbacks?.onStatusChange?.(
                'error',
                'Sessão WebSocket expirada (1008) e renovação recusada. Faça login novamente.',
              );
              return;
            }
          }
          try {
            await this.openSocket();
          } catch {
            // Diagnostics & status already notified.
          }
        })();
      }, delayMs);
    };
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client_disconnect');
      } catch {
        // Ignore close errors.
      }
      this.ws = null;
    }
    this.callbacks?.onStatusChange?.('disconnected');
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
