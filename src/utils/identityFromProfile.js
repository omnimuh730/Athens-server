/** Build resume-generator identity from autoBidProfile (mirrors Athens frontend). */

function str(v) {
  return typeof v === "string" ? v : "";
}

export function identityFromProfile(profile) {
  const location = [str(profile.city).trim(), str(profile.state).trim()].filter(Boolean).join(", ");
  const careersRaw = Array.isArray(profile.careers) ? profile.careers : [];
  const careers = careersRaw
    .map((c) => {
      const row = c ?? {};
      const start = [str(row.startYear), str(row.startMonth)].filter(Boolean).join(".");
      const end = row.endPresent ? "Present" : [str(row.endYear), str(row.endMonth)].filter(Boolean).join(".");
      const period = start || end ? `${start || "?"} – ${end || "?"}` : "";
      return { company: str(row.company), title: str(row.title), period };
    })
    .filter((c) => c.company || c.title);

  const eduRaw = Array.isArray(profile.educations)
    ? profile.educations
    : Array.isArray(profile.education)
      ? profile.education
      : [];
  const education = eduRaw
    .map((e) => {
      const row = e ?? {};
      const start = [str(row.startYear), str(row.startMonth)].filter(Boolean).join(".");
      const end = row.endPresent ? "Present" : [str(row.endYear), str(row.endMonth)].filter(Boolean).join(".");
      const period = start || end ? `${start || "?"} – ${end || "?"}` : "";
      const degree = [str(row.diploma) || str(row.degree), str(row.major) || str(row.field)].filter(Boolean).join(", ");
      return { school: str(row.school) || str(row.university), degree, period };
    })
    .filter((e) => e.school || e.degree);

  return {
    fullName: str(profile.fullName).trim(),
    location,
    email: str(profile.email).trim(),
    phone: str(profile.phone).trim(),
    linkedin: str(profile.linkedin).trim(),
    careers,
    education,
  };
}
