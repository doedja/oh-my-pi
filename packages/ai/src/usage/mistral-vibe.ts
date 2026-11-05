/**
 * Mistral Vibe (`mistral-vibe`) subscription usage.
 *
 * Reads what the Vibe CLI's footer gauge reads (mistralai/mistral-vibe
 * vibe/app_server/_billing.py): `GET /v1/billing/budget` reports the monthly
 * Vibe Code allowance as `vibe_budget.usage_percentage` (0-100, past 100 once
 * pay-as-you-go covers the overage), and `GET /v1/billing/subscription` names
 * the plan and whether pay-as-you-go is on. `/budget` needs the
 * `see_org_inference_usage` permission, so a 403 there means "no gauge", not a
 * bad key. `GET /v1/users/me` adds the account identity when the key may read it.
 */
import { type } from "@oh-my-pi/omptype";
import { ptree } from "@oh-my-pi/pi-utils";
import { ProviderHttpError } from "../error";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { DAY_MS, parseIsoTimestamp, usageStatus } from "./shared";

const PROVIDER = "mistral-vibe";
const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
/** The CLI waits 3 s; a usage refresh can afford a little longer. */
const REQUEST_TIMEOUT_MS = 10_000;
const MONTH_MS = 30 * DAY_MS;
const BUDGET_WINDOW_ID = "1mo";
export const MISTRAL_VIBE_BUDGET_LIMIT_ID = `${PROVIDER}:budget:${BUDGET_WINDOW_ID}`;
/** The CLI's plan titles (vibe/app_server/_account.py); unknown plans show as sent. */
const PLAN_TITLES: Readonly<Record<string, string>> = { FREE: "Free", INDIVIDUAL: "Pro", EDU: "Student", TEAM: "Team" };

const budgetSchema = type({
	"vibe_budget?": type({
		usage_percentage: "number",
		initial_budget: "number",
		"reset_at?": "string | null",
		"payg_enabled?": "boolean | null",
		"currency?": "string | null",
	}).or("null"),
});
const subscriptionSchema = type({ plan_name: "string", "vibe_payg_enabled?": "boolean | null" });
const identitySchema = type({
	"id?": "string",
	"email?": "string | null",
	"organization?": type({ "id?": "string", "name?": "string | null" }).or("null"),
});

type Budget = typeof budgetSchema.infer;

/**
 * GET a billing route. Mistral answers 401 only for an invalid or revoked key,
 * so a 401 from an `authoritative` route throws; every other failure (403 for a
 * member without the usage permission, 404 on a platform without billing, a
 * network error) reads as no data, as it does in the CLI.
 */
async function getJson(
	url: string,
	apiKey: string,
	authoritative: boolean,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<unknown> {
	let response: Response;
	try {
		response = await ctx.fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: ptree.combineSignals(params.signal, REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		ctx.logger?.debug("Mistral Vibe usage request failed", { url, error: String(error) });
		return undefined;
	}
	if (response.status === 401 && authoritative) {
		throw new ProviderHttpError(`Mistral rejected the Vibe key: ${url} returned 401`, 401);
	}
	if (!response.ok) {
		ctx.logger?.debug("Mistral Vibe usage request answered an error", { url, status: response.status });
		return undefined;
	}
	try {
		return await response.json();
	} catch (error) {
		ctx.logger?.debug("Mistral Vibe usage response is unreadable", { url, error: String(error) });
		return undefined;
	}
}

function parsed<T>(value: T | type.errors, url: string, ctx: UsageFetchContext): T | undefined {
	if (!(value instanceof type.errors)) return value;
	ctx.logger?.warn("Mistral Vibe usage response is malformed", { url, error: value.summary });
	return undefined;
}

function trimmed(value: string | null | undefined): string | undefined {
	return value?.trim() || undefined;
}

function buildBudgetLimit(
	detail: NonNullable<Budget["vibe_budget"]>,
	payg: boolean,
	accountId: string | undefined,
	orgId: string | undefined,
): UsageLimit {
	const reported = Math.max(0, detail.usage_percentage);
	const used = Math.min(reported, 100);
	const window: UsageWindow = { id: BUDGET_WINDOW_ID, label: "Monthly", durationMs: MONTH_MS };
	const resetsAt = parseIsoTimestamp(detail.reset_at);
	if (resetsAt !== undefined) window.resetsAt = resetsAt;
	const notes: string[] = [];
	if (payg) notes.push("Pay-as-you-go is on: requests past the allowance are billed");
	if (reported > 100) notes.push(`${Math.floor(reported)}% of the allowance used`);
	return {
		id: MISTRAL_VIBE_BUDGET_LIMIT_ID,
		label: "Vibe allowance",
		// The allowance belongs to the organization: every key on it reports one pool.
		scope: {
			provider: PROVIDER,
			...(accountId ? { accountId } : {}),
			...(orgId ? { orgId } : {}),
			windowId: BUDGET_WINDOW_ID,
			shared: true,
		},
		window,
		amount: {
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: used / 100,
			remainingFraction: 1 - used / 100,
			unit: "percent",
		},
		status: usageStatus(used / 100),
		...(notes.length > 0 ? { notes } : {}),
	};
}

async function fetchMistralVibeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const apiKey = params.credential.type === "api_key" ? params.credential.apiKey?.trim() : undefined;
	if (!apiKey) return null;
	// A configured base URL routes inference; the key must not leave it for the canonical host.
	const baseUrl = (params.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");

	const budgetUrl = `${baseUrl}/billing/budget`;
	const subscriptionUrl = `${baseUrl}/billing/subscription`;
	const identityUrl = `${baseUrl}/users/me`;
	// A rejected key throws out of here so the cached report is purged, not re-served.
	// `/users/me` is only an identity enrichment: a Vibe key may not be allowed to read it.
	const [budgetPayload, subscriptionPayload, identityPayload] = await Promise.all([
		getJson(budgetUrl, apiKey, true, params, ctx),
		getJson(subscriptionUrl, apiKey, true, params, ctx),
		getJson(identityUrl, apiKey, false, params, ctx),
	]);
	const budget = budgetPayload === undefined ? undefined : parsed(budgetSchema(budgetPayload), budgetUrl, ctx);
	const subscription =
		subscriptionPayload === undefined
			? undefined
			: parsed(subscriptionSchema(subscriptionPayload), subscriptionUrl, ctx);
	const identity =
		identityPayload === undefined ? undefined : parsed(identitySchema(identityPayload), identityUrl, ctx);

	const detail = budget?.vibe_budget;
	// No allowance (or none this member may read) leaves nothing to gauge, as in the CLI.
	if (!detail || !Number.isFinite(detail.usage_percentage) || !(detail.initial_budget > 0)) return null;

	const planName = trimmed(subscription?.plan_name);
	const tier = planName ? (PLAN_TITLES[planName.toUpperCase()] ?? planName) : undefined;
	const payg = detail.payg_enabled ?? subscription?.vibe_payg_enabled ?? false;
	const email = trimmed(identity?.email)?.toLowerCase() ?? params.credential.email;
	const accountId = trimmed(identity?.id) ?? params.credential.accountId ?? email;
	const orgId = trimmed(identity?.organization?.id);
	const orgName = trimmed(identity?.organization?.name);

	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits: [buildBudgetLimit(detail, payg, accountId, orgId)],
		metadata: {
			source: budgetUrl,
			paygEnabled: payg,
			...(email ? { email } : {}),
			...(accountId ? { accountId } : {}),
			...(orgId ? { orgId } : {}),
			...(orgName ? { orgName } : {}),
			...(tier ? { tier, planType: tier } : {}),
			...(planName ? { plan: planName } : {}),
		},
		raw: { budget, subscription },
	};
}

export const mistralVibeUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchMistralVibeUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};

/**
 * Pay-as-you-go bills requests past the allowance instead of refusing them, so
 * a spent allowance hard-blocks the key only when pay-as-you-go is off.
 */
export const mistralVibeRankingStrategy: CredentialRankingStrategy = {
	scopeLimits(report) {
		if (report.metadata?.paygEnabled === true) return [];
		return report.limits.filter(limit => limit.id === MISTRAL_VIBE_BUDGET_LIMIT_ID);
	},
	findWindowLimits(report) {
		return { secondary: report.limits.find(limit => limit.id === MISTRAL_VIBE_BUDGET_LIMIT_ID) };
	},
	windowDefaults: {
		// Inert: findWindowLimits never reports a primary window.
		primaryMs: MONTH_MS,
		secondaryMs: MONTH_MS,
	},
};
