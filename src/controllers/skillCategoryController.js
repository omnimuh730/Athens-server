
import { personalInfoCollection } from "../db/mongo.js";

export async function getSkillCategories(req, res) {
	try {
		if (!personalInfoCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}
		const { sort = 'name_asc', page = 1, limit = 30, q = '' } = req.query;
		const pageNum = Math.max(1, parseInt(page, 10) || 1);
		const limitNum = Math.max(1, parseInt(limit, 10) || 30);
		const skip = (pageNum - 1) * limitNum;

		const filter = q ? { name: { $regex: String(q), $options: 'i' } } : {};
		const [docs, total] = await Promise.all([
			personalInfoCollection.find(filter).sort({ name: 1 }).skip(skip).limit(limitNum).toArray(),
			personalInfoCollection.countDocuments(filter),
		]);

		let skills = docs.map((d) => d.name);
		if (sort === 'name_desc') {
			skills = [...skills].sort((a, b) => b.localeCompare(a));
		}

		const skillsDetailed = docs.map((d) => ({
			id: d.canonicalId || d.normalizedKey || d.name,
			label: d.name,
			normalizedKey: d.normalizedKey || null,
		}));

		return res.json({
			success: true,
			skills,
			skillsDetailed,
			pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
		});
	} catch (err) {
		console.error('GET /api/skills-category error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}
