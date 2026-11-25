import { calculateCost } from "../models.ts";
import type {
	AssistantImages,
	ImageApi,
	ImageModel,
	ImageOutputFormat,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
	ImagesOutputContent,
	ProviderHeaders,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

/**
 * pi-image API implementation.
 *
 * Sends pi's own image-generation protocol directly to a backend: the request
 * is a single POST of `{ model, context, options }` to `<baseUrl>/image`, and
 * a `200 OK` response is a completed `{ output, usage?, responseId? }` JSON
 * object. Errors use non-2xx HTTP statuses with the
 * `{ error: { message, code?, details? } }` envelope, matching `pi-messages`
 * and `pi-decision`.
 */

const LABEL = "Pi Image";

export interface PiImageOptions extends ImagesOptions {
	/** Optional session identifier for gateway correlation/analytics. */
	sessionId?: string;
}

/** Wire request body sent by `pi-image` to `POST <baseUrl>/image`. */
export type PiImageRequest = {
	model: string;
	context: ImagesContext;
	options?: {
		aspectRatio?: string;
		size?: string;
		outputFormat?: ImageOutputFormat;
		n?: number;
		sessionId?: string;
		metadata?: Record<string, unknown>;
	};
};

/** Wire response body returned by a `pi-image` backend on `200 OK`. */
export type PiImageResponse = {
	output: ImagesOutputContent[];
	usage?: Usage;
	responseId?: string;
};

interface ImageHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpError(response: Response, body: string): ImageHttpError {
	const error = new Error(`${LABEL} returned ${response.status}`) as ImageHttpError;
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}

function timeoutError(timeoutMs: number): ImageHttpError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as ImageHttpError;
	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function requestHeaders(
	model: ImageModel<ImageApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
): Record<string, string> {
	return (
		providerHeadersToRecord(
			getIdentityHeaders(model, identity),
			{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			model.headers,
			optionsHeaders,
		) ?? {}
	);
}

async function postImageRequest(
	url: URL,
	model: ImageModel<ImageApi>,
	body: unknown,
	options: PiImageOptions | undefined,
): Promise<unknown> {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const apiKey = options.apiKey;
	let payload = body;
	const transformed = await options.onPayload?.(payload, model);
	if (transformed !== undefined) payload = transformed;
	const requestFetch = options.fetch ?? globalThis.fetch;
	return retryProviderRequest(
		async () => {
			const timeoutSignal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
			const signal =
				options.signal && timeoutSignal
					? AbortSignal.any([options.signal, timeoutSignal])
					: (options.signal ?? timeoutSignal);
			try {
				const next = await requestFetch(url, {
					method: "POST",
					headers: requestHeaders(model, apiKey, options.headers, options.identity),
					body: JSON.stringify(payload),
					signal,
				});
				// Reported before the body is read, so a body that fails to arrive still reports its status.
				await options.onResponse?.({ status: next.status, headers: headersToRecord(next.headers) }, model);
				if (!next.ok) throw httpError(next, await next.text());
				return (await next.json()) as unknown;
			} catch (error) {
				if (timeoutSignal?.aborted && !options.signal?.aborted) throw timeoutError(options.timeoutMs!);
				throw error;
			}
		},
		{
			maxRetries: options.maxRetries ?? 2,
			maxRetryDelayMs: options.maxRetryDelayMs,
			signal: options.signal,
		},
	);
}

function parseUsage(value: unknown, model: ImageModel<ImageApi>): Usage | undefined {
	if (!isRecord(value)) return undefined;
	const hasTokens = typeof value.input === "number" || typeof value.output === "number";
	const hasProviderCost =
		isRecord(value.cost) && typeof value.cost.total === "number" && Number.isFinite(value.cost.total);
	if (!hasTokens && !hasProviderCost) return undefined;
	const input = finiteNonNegative(value.input);
	const output = finiteNonNegative(value.output);
	const cacheRead = finiteNonNegative(value.cacheRead);
	const cacheWrite = finiteNonNegative(value.cacheWrite);
	const totalTokens =
		typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens) && value.totalTokens >= 0
			? value.totalTokens
			: input + output + cacheRead + cacheWrite;
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (hasProviderCost) {
		const cost = value.cost as Record<string, unknown>;
		usage.cost = {
			input: finiteNonNegative(cost.input),
			output: finiteNonNegative(cost.output),
			cacheRead: finiteNonNegative(cost.cacheRead),
			cacheWrite: finiteNonNegative(cost.cacheWrite),
			total: finiteNonNegative(cost.total),
			...(typeof cost.totalFromProvider === "boolean" ? { totalFromProvider: cost.totalFromProvider } : {}),
		};
	} else {
		calculateCost(model, usage);
	}
	return usage;
}

function parseOutput(value: unknown): ImagesOutputContent[] {
	if (!Array.isArray(value)) throw new Error(`${LABEL} returned an unexpected response`);
	return value.map((item, index): ImagesOutputContent => {
		if (!isRecord(item)) throw new Error(`${LABEL} returned an invalid output block at index ${index}`);
		if (item.type === "text") {
			if (typeof item.text !== "string") {
				throw new Error(`${LABEL} returned an invalid text block at index ${index}`);
			}
			return { type: "text", text: item.text };
		}
		if (item.type === "image") {
			if (typeof item.data !== "string" || !item.data || typeof item.mimeType !== "string" || !item.mimeType) {
				throw new Error(`${LABEL} returned an invalid image block at index ${index}`);
			}
			return { type: "image", data: item.data, mimeType: item.mimeType };
		}
		throw new Error(`${LABEL} returned an unknown output block type at index ${index}`);
	});
}

/** Image generation through pi's canonical `POST <baseUrl>/image` protocol. */
export const generateImages: ImagesFunction<PiImageOptions> = async (model, context, options) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "pi-image") throw new Error(`Unsupported image API: ${model.api}`);
		const hasInputImages = context.input.some((item) => item.type === "image");
		if (hasInputImages && !model.input.includes("image")) {
			throw new Error(`${LABEL} model ${model.id} does not support image input`);
		}
		if (options?.n !== undefined && (!Number.isInteger(options.n) || options.n < 1)) {
			throw new Error(`${LABEL} option n must be a positive integer`);
		}
		const url = new URL("image", `${model.baseUrl.replace(/\/+$/u, "")}/`);
		const wireOptions: PiImageRequest["options"] = {
			...(options?.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {}),
			...(options?.size !== undefined ? { size: options.size } : {}),
			...(options?.outputFormat !== undefined ? { outputFormat: options.outputFormat } : {}),
			...(options?.n !== undefined ? { n: options.n } : {}),
			...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
		};
		const requestBody: PiImageRequest = {
			model: model.id,
			context: { input: context.input },
			...(Object.keys(wireOptions).length > 0 ? { options: wireOptions } : {}),
		};
		const body = await postImageRequest(url, model, requestBody, options);
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		if (typeof body.responseId === "string" && body.responseId) output.responseId = body.responseId;
		const usage = parseUsage(body.usage, model);
		if (usage) output.usage = usage;
		output.output = parseOutput(body.output);
		return output;
	} catch (error) {
		output.output = [];
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${LABEL} error`);
		return output;
	}
};
