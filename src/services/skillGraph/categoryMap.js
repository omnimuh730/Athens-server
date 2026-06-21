/** Map Neo4j skillType/category to frontend SkillCategory slug. */
export function mapToSkillCategory(skillType, category) {
	const cat = String(category || '').toLowerCase();
	const type = String(skillType || '').toUpperCase();
	if (cat.includes('front')) return 'frontend';
	if (cat.includes('back')) return 'backend';
	if (cat.includes('cloud')) return 'cloud';
	if (cat.includes('database') || cat.includes('data store')) return 'database';
	if (cat.includes('devops') || cat.includes('infra')) return 'devops';
	if (cat.includes('mobile')) return 'mobile';
	if (cat.includes('data') && !cat.includes('database')) return 'data';
	if (type === 'SOFT_SKILL' || cat.includes('soft')) return 'concept';
	if (cat.includes('language') || type === 'TECHNOLOGY') {
		if (cat.includes('framework') || cat.includes('front')) return 'frontend';
		return 'language';
	}
	return 'concept';
}
