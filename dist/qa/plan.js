export const settingLabel = (s) => `${s.mode} · ${s.lang} · ${s.scale.toFixed(1)}×`;
export const shotName = (screen, s) => `${screen}_${s.mode}_${s.lang}_${s.scale.toFixed(1)}x`;
export const shotKey = (screen, s) => `${screen}|${s.mode}|${s.lang}|${s.scale}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function buildPlan(screens, modes, languages, fontScales) {
    const defaultLang = languages[0] ?? 'current';
    const defaultScale = fontScales.includes(1) ? 1 : (fontScales[0] ?? 1);
    const key = screens.filter((s) => s.key);
    const other = screens.filter((s) => !s.key);
    const batches = [];
    for (const mode of modes) {
        for (const scale of fontScales) {
            for (const lang of languages) {
                const names = screens
                    .filter((s) => s.key || (lang === defaultLang && scale === defaultScale))
                    .map((s) => s.name);
                if (names.length)
                    batches.push({ mode, lang, scale, screens: names });
            }
        }
    }
    const total = batches.reduce((n, b) => n + b.screens.length, 0);
    const parts = [
        key.length &&
            `${plural(key.length, 'key screen')} × ${plural(modes.length, 'mode')} × ${plural(languages.length, 'language')} × ${plural(fontScales.length, 'font scale')}`,
        other.length && `${plural(other.length, 'screen')} × ${plural(modes.length, 'mode')}`,
    ].filter(Boolean);
    const summary = `${parts.join(' + ') || 'no screens'} = ${total}, in ${batches.length} batch${batches.length === 1 ? '' : 'es'}`;
    return { batches, total, summary };
}
