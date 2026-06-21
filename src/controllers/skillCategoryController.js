
import { isNeo4jReady } from "../db/neo4j.js";
import { listGraphSkills } from "../services/skillGraph/resolve.js";

export async function getSkillCategories(req, res) {
	try {
		if (!isNeo4jReady()) {
			return res.status(503).json({ success: false, error: 'Neo4j not ready' });
		}
		const { sort = 'name_asc', page = 1, limit = 30, q = '' } = req.query;
		const pageNum = Math.max(1, parseInt(page, 10) || 1);
		const limitNum = Math.max(1, parseInt(limit, 10) || 30);
		const skip = (pageNum - 1) * limitNum;

		const { skills: graphSkills, total } = await listGraphSkills({ q, skip, limit: limitNum });

		let skills = graphSkills.map(s => s.label);
		if (sort === 'name_desc') {
			skills = [...skills].sort((a, b) => b.localeCompare(a));
		}

		return res.json({
			success: true,
			skills,
			skillsDetailed: graphSkills,
			pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
		});
	} catch (err) {
		console.error('GET /api/skills-category error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}
