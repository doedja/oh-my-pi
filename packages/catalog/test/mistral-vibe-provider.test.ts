import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { mistralVibeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const CATALOG_URL = "https://api.mistral.ai/v1/model-catalog?surface=vibe-code";

const capabilities = { completion_chat: true, function_calling: true, vision: true };

/**
 * The live `/model-catalog?surface=vibe-code` answer for a Vibe key
 * (2026-11-05, descriptions dropped), plus a tool-less and an unlabelled entry.
 */
function catalogFixture(): Response {
	return Response.json({
		models: [
			{
				id: "mistral-large-4-0",
				label: "Mistral Large 4",
				aliases: ["mistral-large-4-0-3", "mistral-large-4"],
				publisher: "mistral",
				recommended: true,
				group: null,
				max_context_length: 1_048_576,
				parameters: { temperature: 1.0, reasoning: ["low", "medium", "high"] },
				capabilities,
			},
			{
				id: "mistral-medium-latest",
				label: "Mistral Medium 3.5",
				aliases: ["mistral-medium", "mistral-medium-3.5", "mistral-vibe-cli-latest"],
				publisher: "mistral",
				recommended: false,
				group: null,
				max_context_length: 262_144,
				parameters: { temperature: 1.0, reasoning: ["none", "high"] },
				capabilities,
			},
			{
				id: "zai-glm-5-3",
				label: "GLM 5.3 (Mistral Hosted)",
				aliases: ["glm-5-3", "zai-glm-5", "zai-glm-latest"],
				publisher: "zai",
				max_context_length: 1_048_576,
				parameters: { temperature: 1.0, reasoning: ["low", "high", "max"] },
				capabilities: { ...capabilities, vision: false },
			},
			{
				id: "mistral-small-latest",
				label: "Mistral Small",
				max_context_length: 262_144,
				parameters: { temperature: 0.2, reasoning: ["none"] },
				capabilities: { ...capabilities, vision: false },
			},
			{
				id: "voxtral-mini",
				label: "Voxtral Mini",
				capabilities: { completion_chat: true, function_calling: false },
			},
			{ id: "unlabelled", capabilities },
		],
	});
}

describe("Mistral Vibe model catalog discovery", () => {
	test("maps the Vibe catalog's tool-capable models with their own ladders and the bundled rates", async () => {
		const requests: { url: string; authorization: string | null }[] = [];
		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
			return catalogFixture();
		};

		const models = await mistralVibeModelManagerOptions({
			apiKey: "vibe-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(requests).toEqual([{ url: CATALOG_URL, authorization: "Bearer vibe-key" }]);
		// Medium 3.5 lists the CLI's default id as an alias, so it folds onto that bundled row.
		expect(models?.map(model => model.id)).toEqual([
			"mistral-large-4-0",
			"mistral-vibe-cli-latest",
			"zai-glm-5-3",
			"mistral-small-latest",
		]);

		const medium = models?.find(model => model.id === "mistral-vibe-cli-latest");
		expect(medium).toMatchObject({
			provider: "mistral-vibe",
			api: "openai-completions",
			baseUrl: "https://api.mistral.ai/v1",
			name: "Mistral Medium 3.5",
			input: ["text", "image"],
			contextWindow: 262_144,
			reasoning: true,
			cost: { input: 1.5, output: 7.5, cacheRead: 0.15 },
		});
		// The catalog's ladders survive policy resolution instead of a generic Mistral one.
		expect(buildModel(medium!).thinking?.efforts).toEqual([Effort.High]);
		expect(buildModel(models!.find(model => model.id === "zai-glm-5-3")!).thinking?.efforts).toEqual([
			Effort.Low,
			Effort.High,
			Effort.Max,
		]);

		// An off-only ladder means no reasoning, and the entry decides image input.
		const small = models?.find(model => model.id === "mistral-small-latest");
		expect(small).toMatchObject({ input: ["text"], reasoning: false });
		expect(buildModel(small!).thinking).toBeUndefined();
	});

	test("does not touch the network without a key and rejects a body that is not a catalog", async () => {
		expect(mistralVibeModelManagerOptions({}).fetchDynamicModels).toBeUndefined();

		const notCatalog = async (): Promise<Response> => Response.json({ data: [] });
		const models = await mistralVibeModelManagerOptions({
			apiKey: "vibe-key",
			fetch: notCatalog,
		}).fetchDynamicModels?.();
		expect(models).toBeNull();
	});
});
