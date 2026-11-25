import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import type { generateImages as generateImagesPiFunction } from "../../api/pi-image.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type {
	AssistantImages,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
} from "../../types.ts";

interface OpenRouterImagesProviderModule {
	generateImages: typeof generateImagesOpenRouterFunction;
}

interface PiImagesProviderModule {
	generateImages: typeof generateImagesPiFunction;
}

let openRouterImagesProviderModulePromise: Promise<OpenRouterImagesProviderModule> | undefined;
let piImagesProviderModulePromise: Promise<PiImagesProviderModule> | undefined;

function createLazyLoadErrorImages(model: ImageModel<ImageApi>, error: unknown): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function loadOpenRouterImagesProviderModule(): Promise<OpenRouterImagesProviderModule> {
	openRouterImagesProviderModulePromise ||= import("../../api/openrouter-images.ts").then(
		(module) => module as OpenRouterImagesProviderModule,
	);
	return openRouterImagesProviderModulePromise;
}

export const generateImagesOpenRouter: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenRouterImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

function loadPiImagesProviderModule(): Promise<PiImagesProviderModule> {
	piImagesProviderModulePromise ||= import("../../api/pi-image.ts").then((module) => module as PiImagesProviderModule);
	return piImagesProviderModulePromise;
}

export const generateImagesPi: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadPiImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
	registerImagesApiProvider({
		api: "pi-image",
		generateImages: generateImagesPi,
	});
}

registerBuiltInImagesApiProviders();
