"use client";

import { useEffect, useMemo, useState } from "react";
import { Wand2, Download, Loader2, CheckCircle, AlertCircle, FlaskConical, Image } from "lucide-react";
import { api, fetchHealth, type HealthStatus } from "../lib/api";

type Status = {
  phase: "Idle" | "Generating" | "Complete" | "Error";
  message: string;
  progress: number;
};

type TabKey = "generate" | "pipeline" | "inspiration";

export default function Page() {
  const [active, setActive] = useState<TabKey>("generate");
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        setLoadingHealth(true);
        const h = await fetchHealth(true);
        if (mounted) setHealth(h);
      } catch (e) {
        if (mounted) setHealth(null);
      } finally {
        if (mounted) setLoadingHealth(false);
      }
    };
    load();
    const id = setInterval(load, 20_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="container mx-auto px-4 py-10 max-w-5xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl md:text-5xl font-black bg-gradient-to-r from-purple-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">VECTORIA AI</h1>
            <p className="text-sm md:text-base text-slate-300">AI vector creation pipeline: Gemini → Imagen → Recraft</p>
          </div>
          <HealthBadge health={health} loading={loadingHealth} />
        </div>

        <Tabs active={active} onChange={setActive} />

        <div className="mt-6">
          {active === "generate" && <GenerateTab />}
          {active === "pipeline" && <PipelineTab />}
          {active === "inspiration" && <InspirationTab />}
        </div>

        <div className="text-center mt-10 text-slate-500">
          <p>Powered by Vectoria AI</p>
        </div>
      </div>
    </div>
  );
}

// Append TEMP_ACCESS_TOKEN for protected /temp assets
function addTempToken(url?: string) {
  try {
    if (!url || !url.startsWith('/temp/')) return url as string;
    const token = process.env.NEXT_PUBLIC_TEMP_TOKEN;
    if (!token) return url as string;
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
    u.searchParams.set('token', token);
    return u.toString();
  } catch {
    return url as string;
  }
}

function Tabs({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  const items: { key: TabKey; label: string; icon: any }[] = [
    { key: "generate", label: "Generate", icon: Wand2 },
    { key: "pipeline", label: "Search Pipeline", icon: FlaskConical },
    { key: "inspiration", label: "Inspiration", icon: Image },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 bg-slate-900/50 border border-slate-700 rounded-xl p-1">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={
            "flex items-center justify-center gap-2 py-3 px-4 rounded-lg text-sm font-medium transition-all " +
            (active === it.key ? "bg-gradient-to-r from-purple-600 to-cyan-600" : "hover:bg-slate-800/60")
          }
        >
          <it.icon className="w-5 h-5" />
          {it.label}
        </button>
      ))}
    </div>
  );
}

function HealthBadge({ health, loading }: { health: HealthStatus | null; loading: boolean }) {
  const color = !health ? "bg-slate-700" : health.status === "healthy" ? "bg-emerald-500" : "bg-amber-500";
  const text = !health ? (loading ? "Checking…" : "Unavailable") : health.status;
  const tip = health?.checks?.filter((c) => !c.ok).map((c) => `${c.name}: ${c.reason || "issue"}`).join("; ") || "All good";
  return (
    <div className="inline-flex items-center gap-2 text-sm">
      <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span title={tip} className="text-slate-300">Health: {text}</span>
    </div>
  );
}

function GenerateTab() {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const handleGeneration = async () => {
    const p = prompt.trim();
    if (!p) return alert("Please enter a description");
    setIsGenerating(true);
    setResult(null);
    setStatus({ phase: "Generating", message: "Creating your vector…", progress: 35 });
    try {
  const { data } = await api.post("/api/generate?debug=1", { userPrompt: p });
      setResult(data);
      if (data?.svgCode || data?.svgUrl) setStatus({ phase: "Complete", message: data?.message || "Done", progress: 100 });
      else setStatus({ phase: "Error", message: data?.message || "Generation failed", progress: 100 });
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Generation failed";
      setResult({ success: false, error: msg });
      setStatus({ phase: "Error", message: msg, progress: 100 });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-700 rounded-2xl p-6">
      <h2 className="text-2xl font-bold mb-4 text-purple-300">Create Your Design</h2>
      <div className="space-y-4">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g., Minimalist tech logo with rocket and modern typography"
          className="w-full p-4 bg-slate-800/50 border border-slate-600 rounded-xl text-white placeholder-slate-400 focus:border-purple-400 focus:outline-none resize-none"
          rows={3}
        />
        <button
          onClick={handleGeneration}
          disabled={isGenerating}
          className="w-full bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 py-3 px-6 rounded-xl font-bold text-white transition-all disabled:opacity-50"
        >
          {isGenerating ? (
            <div className="flex items-center justify-center gap-3"><Loader2 className="w-5 h-5 animate-spin" /> Generating…</div>
          ) : (
            <div className="flex items-center justify-center gap-3"><Wand2 className="w-5 h-5" /> Generate Vector</div>
          )}
        </button>
      </div>

      <StatusAndResult status={status} result={result} />
    </div>
  );
}

function PipelineTab() {
  const [term, setTerm] = useState("");
  const [prompt, setPrompt] = useState("");
  const [freeOnly, setFreeOnly] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setIsRunning(true);
    setError(null);
    setResult(null);
    try {
      const { data } = await api.post("/api/pipeline/search-generate-svg", { term: term.trim(), n: 3, prompt: prompt.trim(), freeOnly });
      setResult(data);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || "Pipeline failed");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-700 rounded-2xl p-6">
      <h2 className="text-2xl font-bold mb-4 text-purple-300">Search + Generate</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search term (e.g., cyberpunk icon)" className="p-3 bg-slate-800/50 border border-slate-600 rounded-xl focus:border-purple-400 outline-none" />
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Your creative brief" className="p-3 bg-slate-800/50 border border-slate-600 rounded-xl focus:border-cyan-400 outline-none" />
      </div>
      <div className="flex items-center gap-3 mt-3">
        <label className="inline-flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> Prefer free assets
        </label>
        <button onClick={run} disabled={isRunning || !term || !prompt} className="ml-auto bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 py-2.5 px-4 rounded-lg font-semibold disabled:opacity-50">
          {isRunning ? <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Running…</span> : "Run Pipeline"}
        </button>
      </div>

      <div className="mt-6">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-200 rounded-xl p-3 text-sm">{error}</div>
        )}
        {result && (
          <div className="space-y-6">
            {Array.isArray(result.inspirations) && result.inspirations.length > 0 && (
              <div>
                <h3 className="font-semibold text-cyan-300 mb-2">Inspirations</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {result.inspirations.map((it: any, i: number) => (
                    <div key={i} className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
                      <div className="text-xs text-slate-400 truncate">{it.title || it.page_url}</div>
                      {Array.isArray(it.palette) && (
                        <div className="flex gap-1 mt-2">
                          {it.palette.slice(0, 5).map((c: string, j: number) => (
                            <span key={j} className="w-4 h-4 rounded" style={{ background: c }} />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
      {result.svg_url && (
              <div>
                <h3 className="font-semibold text-purple-300 mb-2">SVG Result</h3>
        <a href={addTempToken(result.svg_url)} target="_blank" className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 px-4 py-2 rounded-lg">
                  <Download className="w-4 h-4" /> Open SVG
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function InspirationTab() {
  const [urls, setUrls] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [features, setFeatures] = useState<any[] | null>(null);
  const [errors, setErrors] = useState<any[] | null>(null);
  const [recipe, setRecipe] = useState<any | null>(null);

  const parsed = useMemo(() => urls.split(/\s+/).map((u) => u.trim()).filter(Boolean), [urls]);

  const extract = async () => {
    setIsLoading(true);
    setFeatures(null);
    setRecipe(null);
    setErrors(null);
    try {
      const { data } = await api.post("/api/inspiration/extract", { urls: parsed });
      setFeatures(data.features || []);
      setErrors(data.errors || []);
    } catch (e: any) {
      setErrors([{ error: e?.response?.data?.message || e?.message }]);
    } finally {
      setIsLoading(false);
    }
  };

  const makeRecipe = async () => {
    setIsLoading(true);
    setRecipe(null);
    try {
      const { data } = await api.post("/api/inspiration/recipe", { urls: parsed });
      setRecipe(data.recipe || null);
    } catch (e: any) {
      setErrors([{ error: e?.response?.data?.message || e?.message }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-700 rounded-2xl p-6">
      <h2 className="text-2xl font-bold mb-4 text-purple-300">Inspiration Extractor</h2>
      <textarea
        value={urls}
        onChange={(e) => setUrls(e.target.value)}
        placeholder="Paste Freepik URLs (space or newline separated)"
        className="w-full p-4 bg-slate-800/50 border border-slate-600 rounded-xl text-white placeholder-slate-400 focus:border-purple-400 focus:outline-none resize-none"
        rows={3}
      />
      <div className="flex items-center gap-3 mt-3">
        <button disabled={isLoading || parsed.length === 0} onClick={extract} className="bg-slate-800 hover:bg-slate-700 border border-slate-600 px-4 py-2 rounded-lg disabled:opacity-50">Extract</button>
        <button disabled={isLoading || parsed.length === 0} onClick={makeRecipe} className="bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 px-4 py-2 rounded-lg disabled:opacity-50">Generate Recipe</button>
      </div>

      <div className="mt-6 space-y-6">
        {isLoading && (
          <div className="flex items-center gap-2 text-slate-300"><Loader2 className="w-4 h-4 animate-spin" /> Working…</div>
        )}
        {Array.isArray(features) && features.length > 0 && (
          <div>
            <h3 className="font-semibold text-cyan-300 mb-2">Extracted Features</h3>
            <div className="grid md:grid-cols-2 gap-3">
              {features.map((f, i) => (
                <div key={i} className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
                  <div className="text-xs text-slate-400 truncate">{f.source_url}</div>
                  <div className="text-xs text-slate-400">Category: {f.category}</div>
                  <div className="flex gap-1 mt-2">
                    {f.palette?.slice(0, 5).map((c: string, j: number) => (
                      <span key={j} className="w-4 h-4 rounded" style={{ background: c }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {recipe && (
          <div>
            <h3 className="font-semibold text-purple-300 mb-2">Style Recipe</h3>
            <pre className="text-xs bg-slate-950/60 border border-slate-700 rounded-lg p-3 whitespace-pre-wrap">{JSON.stringify(recipe, null, 2)}</pre>
          </div>
        )}
        {Array.isArray(errors) && errors.length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/20 text-amber-200 rounded-xl p-3 text-xs">
            {errors.map((e, i) => (
              <div key={i} className="mb-1">• {e.error}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusAndResult({ status, result }: { status: Status | null; result: any }) {
  return (
    <div className="mt-6">
      {status && (
        <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-700 rounded-2xl p-4 mb-6">
          <div className="flex items-center gap-3 mb-3">
            {status.phase === "Complete" ? (
              <CheckCircle className="w-5 h-5 text-emerald-400" />
            ) : status.phase === "Error" ? (
              <AlertCircle className="w-5 h-5 text-red-400" />
            ) : (
              <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
            )}
            <div>
              <div className="font-semibold text-white">{status.phase}</div>
              <div className="text-slate-400 text-sm">{status.message}</div>
            </div>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-2">
            <div className="bg-gradient-to-r from-purple-500 to-cyan-500 h-2 rounded-full transition-all" style={{ width: `${status.progress}%` }} />
          </div>
        </div>
      )}

      {result && (
        <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-700 rounded-2xl p-6">
          <h3 className="text-xl font-bold text-white mb-4">Result</h3>
          {result.success === false && !result.svgCode && !result.svgUrl ? (
            <div className="text-center py-6">
              <AlertCircle className="w-14 h-14 text-red-400 mx-auto mb-3" />
              <h4 className="text-lg font-semibold text-red-300 mb-1">Generation Failed</h4>
              <p className="text-slate-400">{result.error || result.message || "An unexpected error occurred"}</p>
            </div>
          ) : (
            <div className="space-y-5">
              {result.svgCode && (
                <div>
                  <h4 className="text-lg font-semibold text-purple-300 mb-2">Generated Vector</h4>
                  <div className="bg-white p-5 rounded-xl border border-slate-600 flex items-center justify-center min-h-[280px]" dangerouslySetInnerHTML={{ __html: result.svgCode }} />
                </div>
              )}
        {result.rasterImageUrl && (
                <div>
                  <h4 className="text-lg font-semibold text-cyan-300 mb-2">Preview</h4>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={addTempToken(result.rasterImageUrl)} alt="Generated" className="max-w-full h-auto rounded-xl border border-slate-600" />
                </div>
              )}
              <div className="flex gap-3 flex-wrap">
                {result.svgUrl && (
                  <a href={addTempToken(result.svgUrl)} download="vectoria.svg" className="bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 px-5 py-2.5 rounded-xl font-semibold text-white inline-flex items-center gap-2">
                    <Download className="w-4 h-4" /> Download SVG
                  </a>
                )}
                {result.svgCode && (
                  <a
                    href={`data:image/svg+xml;utf8,${encodeURIComponent(result.svgCode)}`}
                    download="vectoria.svg"
                    className="bg-slate-800 hover:bg-slate-700 border border-slate-600 px-5 py-2.5 rounded-xl text-white inline-flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" /> Download Inline SVG
                  </a>
                )}
              </div>
              {result.message && (
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3">
                  <p className="text-emerald-300 text-sm">{result.message}</p>
                </div>
              )}
              {result.enhancedPrompt && (
                <div className="bg-slate-950/50 border border-slate-700 rounded-xl p-3">
                  <div className="text-xs text-slate-400 mb-1">Enhanced prompt</div>
                  <pre className="text-xs whitespace-pre-wrap">{result.enhancedPrompt}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
