import { Injectable } from "@nestjs/common";

// Locale bundles are imported eagerly so they ship inlined in the compiled
// JS — no runtime fs reads, no dist/assets dependency, deploys can't be
// half-broken if the build skips the JSON files.
import en from "./en.json";
import es from "./es.json";
import de from "./de.json";
import fr from "./fr.json";
import it from "./it.json";
import pt from "./pt.json";
import nl from "./nl.json";
import pl from "./pl.json";
import ru from "./ru.json";
import uk from "./uk.json";
import sv from "./sv.json";
import da from "./da.json";
import no from "./no.json";
import fi from "./fi.json";
import cs from "./cs.json";
import el from "./el.json";
import tr from "./tr.json";
import ro from "./ro.json";
import hu from "./hu.json";
import bg from "./bg.json";
import hr from "./hr.json";
import sk from "./sk.json";
import sl from "./sl.json";
import et from "./et.json";
import lv from "./lv.json";
import lt from "./lt.json";
import sr from "./sr.json";
import ca from "./ca.json";
import ga from "./ga.json";
import is from "./is.json";
import fa from "./fa.json";
import ar from "./ar.json";
import ja from "./ja.json";
import ko from "./ko.json";
import zh from "./zh.json";

interface Bundle {
  companyDefaultName: string;
  otpEmail: { subject: string; greeting: string; intro: string; expiry: string };
  supportEmail: { subject: string; greeting: string; body: string; cta: string; signature: string };
}

const BUNDLES: Record<string, Bundle> = {
  en, es, de, fr, it, pt, nl, pl, ru, uk,
  sv, da, no, fi, cs, el, tr, ro, hu, bg,
  hr, sk, sl, et, lv, lt, sr, ca, ga, is,
  fa, ar, ja, ko, zh,
};

const RTL_LOCALES = new Set(["ar", "fa"]);

function normalize(locale: string | null | undefined): string {
  if (!locale) return "en";
  const short = locale.toLowerCase().split(/[-_]/)[0];
  return short in BUNDLES ? short : "en";
}

@Injectable()
export class I18nService {
  bundle(locale: string | null | undefined): Bundle {
    const lng = normalize(locale);
    return BUNDLES[lng] || BUNDLES.en;
  }

  isRtl(locale: string | null | undefined): boolean {
    return RTL_LOCALES.has(normalize(locale));
  }

  /** Format the URL locale segment for legacy app URLs. */
  urlLocale(locale: string | null | undefined): string {
    return normalize(locale);
  }
}
