import { describe, expect, test } from "bun:test";
import { scopedUsageLimits } from "@oh-my-pi/pi-ai/auth/usage-report";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { mistralVibeRankingStrategy, mistralVibeUsageProvider } from "@oh-my-pi/pi-ai/usage/mistral-vibe";

const BASE = "https://api.mistral.ai/v1";
const credential = { type: "api_key" as const, apiKey: "vibe-key" };

interface Routes {
	budget?: Response;
	subscription?: Response;
	identity?: Response;
}

/** Billing API stub; each route answers once with its scripted response. */
function billing(routes: Routes, base = BASE) {
	const requests: { url: string; authorization: string | null }[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const url = String(input);
		requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
		const route =
			url === `${base}/billing/budget`
				? routes.budget
				: url === `${base}/billing/subscription`
					? routes.subscription
					: url === `${base}/users/me`
						? routes.identity
						: undefined;
		if (!route) throw new Error(`Unexpected URL: ${url}`);
		return route;
	};
	return { fetchImpl, requests };
}

function budget(usagePercentage: number, paygEnabled: boolean | null = false): Response {
	return Response.json({
		vibe_budget: {
			usage_percentage: usagePercentage,
			initial_budget: 300,
			currency: "EUR",
			reset_at: "2026-12-01T00:00:00Z",
			payg_enabled: paygEnabled,
		},
		api_budget: { usage_percentage: 3 },
	});
}

const subscription = (vibePayg: boolean | null = false) =>
	Response.json({ plan_name: "INDIVIDUAL", payg_enabled: true, vibe_payg_enabled: vibePayg, enterprise: false });

async function report(routes: Routes): Promise<UsageReport | null> {
	const { fetchImpl } = billing(routes);
	return mistralVibeUsageProvider.fetchUsage({ provider: "mistral-vibe", credential }, { fetch: fetchImpl });
}

describe("Mistral Vibe allowance usage", () => {
	test("reports the monthly Vibe allowance from the billing API with the plan and account", async () => {
		const proxy = "https://mistral-proxy.example/v1";
		const { fetchImpl, requests } = billing(
			{
				budget: budget(42.5),
				subscription: subscription(),
				identity: Response.json({
					id: "user-1",
					email: "Dev@Example.com",
					organization: { id: "org-1", name: "Acme" },
				}),
			},
			proxy,
		);

		const result = await mistralVibeUsageProvider.fetchUsage(
			{ provider: "mistral-vibe", credential, baseUrl: `${proxy}/` },
			{ fetch: fetchImpl },
		);

		// The key stays on the configured endpoint, as inference does.
		expect(requests.map(request => request.url).sort()).toEqual([
			`${proxy}/billing/budget`,
			`${proxy}/billing/subscription`,
			`${proxy}/users/me`,
		]);
		expect(requests.every(request => request.authorization === "Bearer vibe-key")).toBe(true);
		expect(result?.metadata).toMatchObject({
			email: "dev@example.com",
			accountId: "user-1",
			orgId: "org-1",
			orgName: "Acme",
			planType: "Pro",
			paygEnabled: false,
		});
		expect(result?.limits).toEqual([
			expect.objectContaining({
				id: "mistral-vibe:budget:1mo",
				scope: expect.objectContaining({ accountId: "user-1", orgId: "org-1", shared: true }),
				window: expect.objectContaining({ id: "1mo", resetsAt: Date.parse("2026-12-01T00:00:00Z") }),
				amount: expect.objectContaining({ used: 42.5, usedFraction: 0.425, unit: "percent" }),
				status: "ok",
			}),
		]);
	});

	test("a rejected key fails the probe, but identity the key cannot read does not", async () => {
		const rejected = report({
			budget: Response.json({ detail: "Invalid API Key" }, { status: 401 }),
			subscription: subscription(),
			identity: Response.json({ id: "user-1" }),
		});
		await expect(rejected).rejects.toBeInstanceOf(ProviderHttpError);
		await expect(rejected).rejects.toMatchObject({ status: 401 });

		const withoutIdentity = await report({
			budget: budget(10),
			subscription: subscription(),
			identity: Response.json({ detail: "Unauthorized" }, { status: 401 }),
		});
		expect(withoutIdentity?.limits.map(limit => limit.amount.used)).toEqual([10]);
	});

	test("reports nothing when the member may not read the allowance or the plan has none", async () => {
		const forbidden = await report({
			budget: Response.json({ detail: "Forbidden" }, { status: 403 }),
			subscription: subscription(),
			identity: Response.json({}),
		});
		expect(forbidden).toBeNull();

		const noAllowance = await report({
			budget: Response.json({ vibe_budget: { usage_percentage: 0, initial_budget: 0 } }),
			subscription: subscription(),
			identity: Response.json({}),
		});
		expect(noAllowance).toBeNull();
	});

	test("a spent allowance blocks the key only while pay-as-you-go is off", async () => {
		const strict = await report({ budget: budget(104), subscription: subscription(), identity: Response.json({}) });
		expect(strict?.limits[0]).toMatchObject({ status: "exhausted", amount: { used: 100, usedFraction: 1 } });
		expect(scopedUsageLimits(mistralVibeRankingStrategy, strict!, {}).map(limit => limit.id)).toEqual([
			"mistral-vibe:budget:1mo",
		]);

		// The budget omits the flag here; the subscription's Vibe pay-as-you-go setting decides.
		const payg = await report({
			budget: budget(104, null),
			subscription: subscription(true),
			identity: Response.json({}),
		});
		expect(payg?.metadata?.paygEnabled).toBe(true);
		expect(scopedUsageLimits(mistralVibeRankingStrategy, payg!, {})).toEqual([]);
	});
});
