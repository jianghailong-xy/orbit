export default async function (page) {
  console.log(JSON.stringify(await page.evaluate(() => { const t = document.querySelector('.composer-field textarea'); return [...t.attributes].map(a => a.name + '=' + a.value.slice(0, 60)); })));
}
