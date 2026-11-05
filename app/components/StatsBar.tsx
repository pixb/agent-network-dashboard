'use client';

interface StatsBarProps {
  online: number;
  working: number;
  total: number;
  // #53: when true, presence.sseSessions is missing but the hub reports
  // live SSE connections — we're seeing an anonymized/wrong-scope view
  // of /health. `online` is unknowable; render it as '?' with a neutral
  // dot so the card doesn't confidently show 0 while HealthBanner is
  // already surfacing the alert with the CTA.
  presenceUnknown?: boolean;
}

export function StatsBar({ online, working, total, presenceUnknown = false }: StatsBarProps) {
  const onlinePercent = !presenceUnknown && total > 0 ? Math.round((online / total) * 100) : 0;
  // #53: don't render the "fleet is empty" quickstart strip when we
  // literally can't see presence — that state's "0 registered" copy is
  // wrong twice over (registered is per hub, not per SSE, but users
  // read the strip together). fleetEmpty only applies when total is
  // truly 0 in this scope; when total is 0 AND presence unknown, we
  // still emit the strip but leave the online cell as '?' so the copy
  // stops asserting "you have nothing".
  const fleetEmpty = total === 0;
  const onlineDisplay: number | string = presenceUnknown ? '?' : online;
  const offlineDisplay: number | string = presenceUnknown ? '?' : (total - online);

  // #209 R29 (mobile vertical rhythm — goal "大幅提升移动端体验"):
  // populated branch previously left mb-8 (32 px) below the 4-card grid,
  // the single biggest gap on the Overview page. Drop to mb-4 (16 px)
  // on phones, restore mb-8 from sm: up. Pairs with R28's section-gap
  // tighten — together they reclaim ~48 px of pure scroll waste before
  // the agent grid. The empty-fleet branch already used mb-4 since R72,
  // so this only touches the populated case.
  return (
    <div className={fleetEmpty ? 'mb-4' : 'mb-4 sm:mb-8'}>
      {/* Title row. #217 S3 dropped the version/uptime subtitle (lives in
          Settings → CommHub Connection). S9 (Vincent tg 613 "没居中"):
          WeChat-style centered title on phones — centering also clears
          the fixed hamburger symmetrically, replacing the old ml-10
          indent that read as misalignment. Left-aligned from lg: up. */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-white tracking-tight text-center lg:text-left">Agent Network</h1>
      </div>

      {fleetEmpty ? (
        /* Round 72: thin status strip replaces the 4-card grid when fleet
           is empty. Saves ~280px on mobile (CTA y=650 → ~370) and keeps
           the same data visible in a single inline row. #53: when
           presence is unknown, the "0 online" copy would be a false
           assertion — swap to '?' so the row reads honestly and pairs
           with the HealthBanner alert above. */
        <div className="anet-stat-strip flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-500 border-t border-b border-[#26262b] py-2">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full bg-gray-600" />
            <span className="text-gray-300 tabular-nums">{onlineDisplay}</span> online
          </span>
          <span className="text-gray-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full bg-gray-600" />
            <span className="text-gray-300 tabular-nums">0</span> working
          </span>
          <span className="text-gray-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full bg-gray-600" />
            <span className="text-gray-300 tabular-nums">0</span> registered
          </span>
        </div>
      ) : (
        <>
        {/* #217 M1 (Vincent: "再简洁点你自己理解一下"): on phones the
            populated state reuses the round-72 thin strip instead of
            the card grid — one quiet line of numbers, ~70px reclaimed.
            Cards return from sm: up where they have room to breathe. */}
        <div className="sm:hidden anet-stat-strip flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-500 border-t border-b border-[#26262b] py-2">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`inline-block w-1.5 h-1.5 rounded-full ${presenceUnknown ? 'bg-gray-500' : 'bg-green-400'}`} />
            <span className="text-gray-200 tabular-nums">{onlineDisplay}</span> online
          </span>
          {working > 0 && (
            <>
              <span className="text-gray-700">·</span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 anet-brand-pulse" />
                <span className="text-gray-200 tabular-nums">{working}</span> working
              </span>
            </>
          )}
          <span className="text-gray-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full bg-gray-600" />
            <span className="text-gray-200 tabular-nums">{offlineDisplay}</span> offline
          </span>
          <span className="text-gray-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-gray-200 tabular-nums">{total}</span> total
          </span>
        </div>
        {/* Populated state, sm: up. #217 S2 (less is more): the Working
           card only earns its grid cell when something is actually
           working. */}
        <div className={`hidden sm:grid gap-3 ${working > 0 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
          <StatCard
            value={onlineDisplay}
            label="Online"
            sub={presenceUnknown ? 'presence unavailable' : `${onlinePercent}% of fleet`}
            color={presenceUnknown ? 'text-gray-400' : 'text-green-400'}
          />
          {working > 0 && (
            <StatCard
              value={working}
              label="Working"
              sub={!presenceUnknown && online > 0 ? `${Math.round((working / online) * 100)}% utilization` : '--'}
              color="text-cyan-400"
            />
          )}
          <StatCard
            value={offlineDisplay}
            label="Offline"
            sub={presenceUnknown ? 'presence unavailable' : (total - online === 0 ? 'All systems go' : `${total - online} disconnected`)}
            color="text-gray-400"
          />
          <StatCard
            value={total}
            label="Total"
            sub="Registered nodes"
            color="text-white"
          />
        </div>
        </>
      )}
    </div>
  );
}

function StatCard({ value, label, sub, color }: {
  value: number | string; label: string; sub: string; color: string;
}) {
  // #217 D2 (OpenWebUI-style color restraint): the per-color gradient
  // wash + tinted borders made the KPI row read as four neon billboards.
  // Surfaces are now neutral (shared border + bg); color survives only
  // on the number itself. Mobile density values are #209 R39.
  return (
    <div className="anet-stat-card rounded-2xl border border-transparent bg-[var(--bg-secondary)] px-3 sm:px-4 py-2.5 sm:py-3 transition-all">
      <div className={`text-2xl sm:text-3xl font-bold ${color} tabular-nums leading-tight`}>{value}</div>
      <div className="text-xs sm:text-sm text-gray-300 mt-0.5">{label}</div>
      <div className="text-[11px] sm:text-xs text-gray-500 mt-1">{sub}</div>
    </div>
  );
}
