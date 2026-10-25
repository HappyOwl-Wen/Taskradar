import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, SwitchRow } from "@/components/ui/form";
import { extractImageColor } from "@/lib/imagePalette";
import { SimpleSelect } from "@/components/ui/select";
import { DEFAULT_APPEARANCE, MAX_BACKGROUND_BYTES, setAppearance, setBackgroundImage, useAppearance, type Appearance } from "@/lib/appearance";
import { SettingsCard } from "./common";

export function AppearanceSection() {
  const { t } = useTranslation();
  const value = useAppearance();
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const update = (changes: Partial<Appearance>) => {
    try { setAppearance(changes); }
    catch { toast.error(t("appearance.storageError")); }
  };
  const matchImage = async () => {
    setLoading(true);
    try { update({ imageAccent: await extractImageColor(value.image), autoColor: true }); }
    catch { toast.error(t("appearance.matchError")); }
    finally { setLoading(false); }
  };
  const upload = async (file: File) => {
    const request = ++generation.current;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > MAX_BACKGROUND_BYTES) {
      toast.error(t("appearance.imageError")); return;
    }
    setLoading(true);
    try {
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
      });
      const preview = new Image(); preview.src = image; await preview.decode();
      if (request === generation.current) {
        try { await setBackgroundImage(image); }
        catch { toast.error(t("appearance.storageError")); }
      }
    } catch { toast.error(t("appearance.imageError")); }
    finally { if (request === generation.current) setLoading(false); }
  };
  return (
    <SettingsCard id="appearance" title={t("appearance.title")} description={t("appearance.hint")}>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t("appearance.background")} htmlFor="appearance-background">
          <SimpleSelect id="appearance-background" value={value.background} onValueChange={(background) => update({ background })}
            options={(["landscape", "solid", ...(value.image ? ["image"] : [])] as Appearance["background"][]).map((background) => ({ value: background, label: t(`appearance.${background}`) }))} />
        </Field>
        <Field label={t("appearance.color")} htmlFor="appearance-color">
          <div className="flex flex-wrap items-center gap-2">
            {["#7050ad", "#2563eb", "#0d9488", "#d97706", "#db2777"].map((color) => (
              <button type="button" key={color} aria-label={`${t("appearance.color")} ${color}`} aria-pressed={value.color === color}
                className="size-8 rounded-full border-2 border-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-ring aria-pressed:ring-offset-2"
                style={{ backgroundColor: color }} onClick={() => update({ color })} />
            ))}
            <input id="appearance-color" type="color" className="h-9 w-12 cursor-pointer" value={value.color} onChange={(event) => update({ color: event.target.value })} />
          </div>
        </Field>
      </div>
      <SwitchRow id="appearance-auto-color" label={t("appearance.autoColor")} hint={t("appearance.autoColorHint")} checked={value.autoColor} disabled={loading}
        onCheckedChange={(autoColor) => { if (autoColor && value.image && !value.imageAccent) void matchImage(); else update({ autoColor }); }} />
      <SwitchRow id="appearance-high-contrast" label={t("appearance.highContrast")} hint={t("appearance.highContrastHint")} checked={value.highContrast}
        onCheckedChange={(highContrast) => update({ highContrast })} />
      <Field label={t("appearance.upload")} hint={t("appearance.imageHint")} htmlFor="appearance-image">
        <input id="appearance-image" type="file" accept="image/png,image/jpeg,image/webp" disabled={loading} className="w-full text-sm file:mr-3 file:rounded-md file:border file:px-3 file:py-2"
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
        {loading ? <p role="status">{t("appearance.loading")}</p> : null}
        {value.image ? <div className="flex items-center gap-3">
          <img src={value.image} alt={t("appearance.image")} className="h-20 w-32 rounded-lg object-cover" />
          <Button variant="outline" disabled={loading} onClick={() => update({ image: "", background: "landscape" })}>{t("appearance.remove")}</Button>
          <Button variant="outline" disabled={loading} onClick={() => void matchImage()}>{t("appearance.matchImage")}</Button>
        </div> : null}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={`${t("appearance.transparency")} · ${value.transparency}%`} hint={t("appearance.transparencyHint")} htmlFor="appearance-transparency">
          <input id="appearance-transparency" type="range" min="0" max="100" value={value.transparency} className="w-full accent-primary" onChange={(event) => update({ transparency: Number(event.target.value) })} />
        </Field>
        <Field label={`${t("appearance.blur")} · ${value.blur} px`} htmlFor="appearance-blur">
          <input id="appearance-blur" type="range" min="0" max="30" value={value.blur} className="w-full accent-primary" onChange={(event) => update({ blur: Number(event.target.value) })} />
        </Field>
      </div>
      <Button variant="outline" className="justify-self-start" disabled={loading} onClick={() => update({ ...DEFAULT_APPEARANCE })}>{t("appearance.reset")}</Button>
    </SettingsCard>
  );
}
