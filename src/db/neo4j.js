import neo4j from 'neo4j-driver';

let driver = null;

export function getNeo4jDriver() {
	return driver;
}

export async function initNeo4j() {
	const uri = process.env.NEO4J_URI || 'bolt://127.0.0.1:7687';
	const user = process.env.NEO4J_USER || 'neo4j';
	const password = process.env.NEO4J_PASSWORD || 'skillgraph-dev';

	const candidate = neo4j.driver(uri, neo4j.auth.basic(user, password), {
		maxConnectionPoolSize: 50,
		connectionAcquisitionTimeout: 30_000,
	});

	try {
		await candidate.verifyConnectivity();
		driver = candidate;
		console.log('Connected to Neo4j', uri);
		await ensureGraphSchema();
	} catch (err) {
		await candidate.close().catch(() => {});
		driver = null;
		throw err;
	}
}

export async function closeNeo4j() {
	if (driver) {
		await driver.close();
		driver = null;
	}
}

export async function runRead(cypher, params = {}) {
	if (!driver) throw new Error('Neo4j not initialized');
	const session = driver.session({ defaultAccessMode: neo4j.session.READ });
	try {
		const result = await session.run(cypher, params);
		return result.records;
	} finally {
		await session.close();
	}
}

/** Run multiple read queries in a single session (avoids open/close per query). */
export async function runReadBatch(queries) {
	if (!driver) throw new Error('Neo4j not initialized');
	const session = driver.session({ defaultAccessMode: neo4j.session.READ });
	try {
		const results = [];
		for (const { cypher, params = {} } of queries) {
			const result = await session.run(cypher, params);
			results.push(result.records);
		}
		return results;
	} finally {
		await session.close();
	}
}

export async function runWrite(cypher, params = {}) {
	if (!driver) throw new Error('Neo4j not initialized');
	const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
	try {
		const result = await session.run(cypher, params);
		return result.records;
	} finally {
		await session.close();
	}
}

async function ensureGraphSchema() {
	const statements = [
		'CREATE CONSTRAINT skill_id IF NOT EXISTS FOR (s:Skill) REQUIRE s.id IS UNIQUE',
		'CREATE CONSTRAINT raw_alias_key IF NOT EXISTS FOR (a:RawAlias) REQUIRE a.normalizedKey IS UNIQUE',
		'CREATE INDEX skill_label IF NOT EXISTS FOR (s:Skill) ON (s.label)',
		'CREATE INDEX skill_category IF NOT EXISTS FOR (s:Skill) ON (s.category)',
	];

	for (const cypher of statements) {
		await runWrite(cypher);
	}
}

export function isNeo4jReady() {
	return Boolean(driver);
}

/** Neo4j SKIP/LIMIT require integer types — plain JS numbers can fail as 0.0. */
export function toNeo4jInt(n) {
	return neo4j.int(Math.max(0, Math.floor(Number(n) || 0)));
}
