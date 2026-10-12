/**
 * Deterministic multi-agent planner plus an optional OpenAI-compatible
 * adapter. The rules-based planner always runs first and is the fallback
 * whenever no AI key is configured or the provider fails, so project intake
 * never blocks on a third party.
 */

/**
 * @typedef {Object} AgentTemplate
 * @property {string} name
 * @property {string} role
 * @property {string} title
 * @property {string} description
 */

/** @type {AgentTemplate[]} */
const agentTemplates = [
  { name: 'Project Analyst', role: 'planner', title: 'Analyze request and define scope', description: 'Extract the goal, audience, constraints, deliverables, and acceptance criteria.' },
  { name: 'Brand & Research Agent', role: 'research', title: 'Research audience and positioning', description: 'Identify target audiences, competitors to research, differentiators, and brand voice.' },
  { name: 'Website Builder Agent', role: 'website', title: 'Plan website and conversion flow', description: 'Define pages, mobile behavior, accessibility, forms, and conversion goals.' },
  { name: 'SEO / GEO / AEO Agent', role: 'seo', title: 'Create search visibility plan', description: 'Plan technical SEO, keyword clusters, local SEO, structured data, and answer-engine content.' },
  { name: 'Creative Studio Agent', role: 'creative', title: 'Create creative production briefs', description: 'Prepare platform-specific image/video creative briefs while preserving supplied product details.' },
  { name: 'Social Distribution Agent', role: 'social', title: 'Build channel content calendar', description: 'Plan channel-specific posts, hooks, captions, formats, and suggested posting windows.' },
  { name: 'Growth & Lead Agent', role: 'growth', title: 'Plan lead generation and campaigns', description: 'Define lead magnets, landing page CTAs, campaign experiments, and budget guardrails.' },
  { name: 'QA & Compliance Agent', role: 'qa', title: 'Review quality, risk, and approvals', description: 'Check consistency, mobile readiness, claims, privacy, accessibility, and approval gates.' },
];

/**
 * Build the deterministic plan for a brief (English, Urdu script or Roman
 * Urdu). This function has no I/O and is covered by unit tests.
 *
 * @param {unknown} prompt
 * @param {string} [projectName]
 * @returns {import('./types.js').Plan}
 */
export function buildPlan(prompt, projectName = 'New project') {
  const cleanPrompt = String(prompt || '').trim();
  const lower = cleanPrompt.toLowerCase();

  /** @type {import('./types.js').PlanTask[]} */
  const tasks = agentTemplates.map((a, i) => ({
    id: `task_${i + 1}`,
    agent: a.name,
    role: a.role,
    title: a.title,
    description: a.description,
    status: 'queued',
    priority: i === 0 || i === 7 ? 'high' : 'normal',
    requiresApproval: ['social', 'growth'].includes(a.role),
    output: null,
  }));

  /** @type {string[]} */
  const deliverables = [];
  if (/website|web site|store|shopify|landing page|site/.test(lower)) deliverables.push('Website structure and conversion-ready page plan');
  if (/seo|geo|aeo|google|search/.test(lower)) deliverables.push('SEO/GEO/AEO implementation checklist');
  if (/social|instagram|facebook|tiktok|youtube|content|post/.test(lower)) deliverables.push('Platform-specific content calendar and creative briefs');
  if (/ad|advert|campaign|marketing/.test(lower)) deliverables.push('Marketing campaign plan with approval gates');
  if (/brand|logo|identity/.test(lower)) deliverables.push('Brand positioning and identity brief');
  if (!deliverables.length) deliverables.push('Project plan, requirements, quality checklist, and next actions');

  return {
    projectName: String(projectName || 'New project').slice(0, 120),
    summary: cleanPrompt.slice(0, 700),
    languageDetected: /[\u0600-\u06FF]/.test(cleanPrompt)
      ? 'Urdu/Arabic script likely'
      : /\b(mujy|mujhe|k liye|bana do|kar do|hai)\b/i.test(cleanPrompt)
        ? 'Roman Urdu/Hindi likely'
        : 'English or mixed',
    deliverables,
    acceptanceCriteria: [
      'Requirements and assumptions are recorded',
      'Mobile-first quality is included',
      'SEO and accessibility are reviewed where relevant',
      'External actions remain approval-gated',
      'Final outputs include a clear QA checklist',
    ],
    tasks,
    safety: {
      externalPublishing: 'approval_required',
      adSpend: 'approval_required',
      purchases: 'approval_required',
      bulkOutreach: 'approval_required',
      deployment: 'approval_required',
    },
  };
}

/**
 * Coerce an untrusted AI array into a bounded string array.
 * @param {unknown} value
 * @param {string[]} fallback
 * @param {number} maxItems
 * @param {number} maxLen
 * @returns {string[]}
 */
function strArray(value, fallback, maxItems, maxLen) {
  if (!Array.isArray(value)) return fallback;
  const items = /** @type {unknown[]} */ (value);
  return items.slice(0, maxItems).map((item) => String(item).slice(0, maxLen));
}

/**
 * @param {string} prompt
 * @param {string} projectName
 * @param {import('./types.js').AppConfig['ai']} ai
 * @returns {Promise<import('./types.js').Plan>}
 */
export async function createPlan(prompt, projectName, ai) {
  const fallback = buildPlan(prompt, projectName);
  if (!ai || !ai.apiKey) {
    return {
      ...fallback,
      planningMode: 'rules-based fallback',
      aiNote: 'AI_API_KEY is not configured. Plan was created with the built-in planner.',
    };
  }

  try {
    const response = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({
        model: ai.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a careful business project planner. Return JSON with keys projectName, summary, deliverables (array of strings), acceptanceCriteria (array of strings), risks (array of strings), recommendedAgents (array of strings). Do not claim to perform external actions. Never request secrets. All publishing, ad spend, purchases, deployments, and bulk outreach require human approval.',
          },
          { role: 'user', content: `Project name: ${projectName || 'New project'}\nUser request: ${String(prompt).slice(0, 10000)}` },
        ],
      }),
      signal: AbortSignal.timeout(ai.timeoutMs),
    });
    if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);

    /** @type {any} */
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') throw new Error('AI provider returned an unexpected payload');
    /** @type {any} */
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('AI plan was not a JSON object');

    /** @type {import('./types.js').Plan} */
    const merged = {
      ...fallback,
      ...parsed,
      projectName: String(parsed.projectName || fallback.projectName).slice(0, 120),
      summary: String(parsed.summary || fallback.summary).slice(0, 2000),
      deliverables: strArray(parsed.deliverables, fallback.deliverables, 30, 300),
      acceptanceCriteria: strArray(parsed.acceptanceCriteria, fallback.acceptanceCriteria, 30, 300),
      risks: strArray(parsed.risks, [], 30, 300),
      recommendedAgents: strArray(parsed.recommendedAgents, [], 30, 120),
      tasks: fallback.tasks,
      safety: fallback.safety,
      planningMode: 'AI-assisted',
      aiNote: 'AI-assisted plan created. Review outputs before execution.',
    };
    return merged;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...fallback,
      planningMode: 'rules-based fallback',
      aiNote: `AI planning unavailable (${message.slice(0, 140)}). A fallback plan was created.`,
    };
  }
}
