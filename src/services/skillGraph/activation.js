/**
 * Spreading-activation engine for skill knowledge graph scoring.
 * Ported from Athens/src/app/features/knowledge-graph/lib/activation.ts
 */

export const RELATION_MULTIPLIER = {
	PREREQUISITE_OF: 1.0,
	BUILDS_ON: 0.95,
	USED_WITH: 0.8,
	RELATED_TO: 0.6,
	PART_OF: 0.7,
	ALTERNATIVE_TO: 0.5,
	SPECIALIZATION_OF: 0.75,
};

export const DEFAULT_PARAMS = {
	alpha: 0.82,
	lambda: 0.35,
	eta: 0.6,
	maxIterations: 100,
	tolerance: 1e-6,
};

export function edgeKey(from, to) {
	return `${from}->${to}`;
}

export function buildEffectiveWeights(graph, cooccurrence = {}, params = DEFAULT_PARAMS) {
	const weights = {};
	const add = (from, to, w) => {
		const k = edgeKey(from, to);
		weights[k] = Math.max(weights[k] ?? 0, w);
	};

	for (const edge of graph.edges) {
		const mult = RELATION_MULTIPLIER[edge.type] ?? 0.5;
		const base = edge.weight * mult;
		const hebbian = params.eta * (cooccurrence[edgeKey(edge.from, edge.to)] ?? 0);
		const effective = Math.min(1, base + hebbian);
		add(edge.from, edge.to, effective);
		add(edge.to, edge.from, effective);
	}

	return weights;
}

export function buildEvidenceVector(items, params = DEFAULT_PARAMS) {
	const vector = {};
	const contributors = {};

	for (const item of items) {
		const recency = Math.exp(-params.lambda * Math.max(0, item.ageYears ?? 0));
		const raw = (item.proficiency ?? 1) * recency * Math.log(1 + (item.freq ?? 1));
		vector[item.id] = (vector[item.id] ?? 0) + raw;
		contributors[item.id] = [...new Set([...(contributors[item.id] ?? []), ...(item.sources ?? ['user'])])];
	}

	const total = Object.values(vector).reduce((s, v) => s + v, 0);
	if (total > 0) {
		for (const id of Object.keys(vector)) vector[id] /= total;
	}

	return { vector, contributors };
}

export function personalizedPageRank(nodeIds, effectiveWeights, evidence, params = DEFAULT_PARAMS) {
	const index = new Map(nodeIds.map((id, i) => [id, i]));
	const n = nodeIds.length;
	const neighbors = Array.from({ length: n }, () => []);
	const outSum = new Float64Array(n);

	for (const [key, w] of Object.entries(effectiveWeights)) {
		const [from, to] = key.split('->');
		const fi = index.get(from);
		const ti = index.get(to);
		if (fi === undefined || ti === undefined || w <= 0) continue;
		neighbors[fi].push({ to: ti, w });
		outSum[fi] += w;
	}

	const e = new Float64Array(n);
	let eTotal = 0;
	for (const id of nodeIds) eTotal += evidence[id] ?? 0;
	if (eTotal > 0) {
		for (let i = 0; i < n; i++) e[i] = (evidence[nodeIds[i]] ?? 0) / eTotal;
	} else {
		for (let i = 0; i < n; i++) e[i] = 1 / n;
	}

	let a = new Float64Array(e);
	let iterations = 0;

	for (let step = 0; step < params.maxIterations; step++) {
		const next = new Float64Array(n);
		for (let i = 0; i < n; i++) next[i] = (1 - params.alpha) * e[i];

		let dangling = 0;
		for (let i = 0; i < n; i++) {
			if (outSum[i] === 0) {
				dangling += a[i];
				continue;
			}
			const share = (params.alpha * a[i]) / outSum[i];
			for (const out of neighbors[i]) {
				next[out.to] += share * out.w;
			}
		}
		if (dangling > 0) {
			for (let i = 0; i < n; i++) next[i] += params.alpha * dangling * e[i];
		}

		let diff = 0;
		for (let i = 0; i < n; i++) diff += Math.abs(next[i] - a[i]);
		a = next;
		iterations = step + 1;
		if (diff < params.tolerance) break;
	}

	let max = 0;
	for (let i = 0; i < n; i++) max = Math.max(max, a[i]);
	const activation = {};
	for (let i = 0; i < n; i++) {
		activation[nodeIds[i]] = max > 0 ? a[i] / max : 0;
	}

	return { activation, iterations };
}

export function computeActivation(graph, evidenceItems, params = DEFAULT_PARAMS) {
	const effectiveWeights = buildEffectiveWeights(graph, {}, params);
	const { vector: evidence } = buildEvidenceVector(evidenceItems, params);
	const nodeIds = graph.nodes.map(n => n.id);
	const { activation, iterations } = personalizedPageRank(nodeIds, effectiveWeights, evidence, params);
	return { activation, iterations, edgeWeights: effectiveWeights };
}

/** Direct match weights when graph is sparse or activation unavailable. */
export const DIRECT_MATCH_WEIGHTS = {
	direct: 1.0,
	BUILDS_ON: 0.85,
	PREREQUISITE_OF: 0.85,
	SPECIALIZATION_OF: 0.75,
	RELATED_TO: 0.55,
	USED_WITH: 0.55,
	ALTERNATIVE_TO: 0.4,
	PART_OF: 0.2,
	unresolved: 0.5,
	ROLE: 0.3,
	SOFT_SKILL: 0.3,
};
