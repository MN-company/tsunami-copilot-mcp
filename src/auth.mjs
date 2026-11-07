/** Copies the site's cookies from a Playwright context into the local jar (values stay on disk, 0600). */
export async function importBrowserCookies(context, jar) {
  const cookies = (await context.cookies('https://www.tsunaminutrition.it')).filter(c => /(^|\.)tsunaminutrition\.it$/.test(c.domain));
  jar.replaceAll(cookies.map(c => [c.name, c.value]));
  await jar.save();
  return cookies.length;
}
