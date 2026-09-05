export const dynamic = 'force-dynamic';
export const runtime = 'edge';
import { NextRequest } from "next/server";
import {
  buildFranchiseGraph,
  FRANCHISE_GRAPH_CACHE,
  FRANCHISE_GRAPH_TTL,
  anilistQuery,
  FranchiseNode,
  DEFAULT_FETCH_USER_AGENT,
} from "@/lib/anime-fetch";
import { discoverFranchiseNodesViaKitsu } from "@/lib/kitsu";
import { tmdbFetch, searchTmdbShow } from "@/lib/tmdb";

const watchOrderCacheHeaders = {
  "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
  "CDN-Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
  "Cloudflare-CDN-Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
} as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) {
    return Response.json({ success: true, data: { franchiseNodes: [] } }, { headers: watchOrderCacheHeaders });
  }

  const { searchParams } = new URL(request.url);
  let title = searchParams.get("title") || "";

  try {
    let targetNumId = parseInt(id.replace(/\D/g, ""), 10);
    const kitsuId = id.startsWith("kitsu-") ? id.replace("kitsu-", "") : null;
    const malId = id.startsWith("mal-") ? id.replace("mal-", "") : null;
    let tmdbId: number | null = id.startsWith("tmdb-") ? parseInt(id.replace("tmdb-", ""), 10) : null;
    if (isNaN(tmdbId as number)) tmdbId = null;

    // 1. Cross-platform resolution via AniZip
    let queryParam = "";
    if (kitsuId) queryParam = `kitsu_id=${kitsuId}`;
    else if (malId) queryParam = `mal_id=${malId}`;
    else if (tmdbId) queryParam = `themoviedb_id=${tmdbId}`;
    else if (!isNaN(targetNumId) && targetNumId > 0) queryParam = `anilist_id=${targetNumId}`;

    if (queryParam) {
      try {
        const azRes = await fetch(`https://api.ani.zip/mappings?${queryParam}`, {
          signal: AbortSignal.timeout(3000),
          headers: { "User-Agent": DEFAULT_FETCH_USER_AGENT },
        });
        if (azRes.ok) {
          const az = await azRes.json();
          if (az?.mappings?.themoviedb_id && !tmdbId) {
            const parsed = parseInt(String(az.mappings.themoviedb_id), 10);
            if (!isNaN(parsed) && parsed > 0) tmdbId = parsed;
          }
          if (az?.mappings?.anilist_id && (!targetNumId || isNaN(targetNumId))) {
            targetNumId = parseInt(String(az.mappings.anilist_id), 10);
          }
          if (!title) {
            title = az?.titles?.en || az?.titles?.rj || az?.titles?.en_us || "";
          }
        }
      } catch {}
    }

    // 2. Check server in-memory cache (instant)
    const cleanId = String(id || "").trim();
    if (cleanId && cleanId !== "NaN" && cleanId !== "null") {
      const cached = FRANCHISE_GRAPH_CACHE.get(cleanId) || (!isNaN(targetNumId) && targetNumId > 0 ? FRANCHISE_GRAPH_CACHE.get(targetNumId) : null);
      if (cached && Date.now() - cached.timestamp < FRANCHISE_GRAPH_TTL && cached.nodes?.length > 1) {
        return Response.json({
          success: true,
          data: { franchiseNodes: cached.nodes },
        }, { headers: watchOrderCacheHeaders });
      }
    }

    // 3. Perform the deep franchise BFS crawl via AniList
    let nodes: FranchiseNode[] = [];
    if (!isNaN(targetNumId) && targetNumId > 0 && !id.startsWith("kitsu-")) {
      try {
        nodes = await buildFranchiseGraph(targetNumId);
      } catch {}
    }

    // 4. Universal Fallback & Comprehensive Franchise Discovery via Kitsu
    // If AniList graph returned few TV seasons (e.g. 1-hop crawl only or GraphQL 403),
    // discover ALL franchise parts (seasons, movies, OVAs, ONAs) dynamically across Kitsu
    const currentTvCount = (nodes || []).filter(n => (n.format || "TV").toUpperCase() === "TV").length;
    if (!nodes || nodes.length <= 1 || currentTvCount < 3) {
      try {
        const searchKeyword = title || (kitsuId ? `kitsu-${kitsuId}` : String(targetNumId));
        const kitsuNodes = await discoverFranchiseNodesViaKitsu(searchKeyword, kitsuId || undefined);
        if (kitsuNodes && kitsuNodes.length > 0) {
          if (!nodes || nodes.length <= 1) {
            nodes = kitsuNodes;
          } else {
            // Merge existing nodes with Kitsu nodes, deduplicating by ID, MAL ID, or normalized title
            const seen = new Set<string>();
            const merged: FranchiseNode[] = [];

            const addNode = (n: FranchiseNode) => {
              const idStr = String(n.id).trim().toLowerCase();
              const malStr = n.idMal ? `mal-${n.idMal}` : "";
              const titleKey = (n.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();

              if (seen.has(idStr) || (malStr && seen.has(malStr)) || (titleKey && seen.has(titleKey))) {
                return;
              }
              seen.add(idStr);
              if (malStr) seen.add(malStr);
              if (titleKey) seen.add(titleKey);
              merged.push(n);
            };

            for (const n of nodes) addNode(n);
            for (const n of kitsuNodes) addNode(n);
            nodes = merged;
          }
        }
      } catch (err) {
        console.error("[Watch Order Kitsu Discovery Error]:", err);
      }
    }



    // Sort nodes chronologically
    const formatOrder: Record<string, number> = { TV: 0, TV_SHORT: 1, ONA: 2, OVA: 3, SPECIAL: 4, MOVIE: 5 };
    nodes.sort((a, b) => {
      const yA = a.seasonYear || 9999, yB = b.seasonYear || 9999;
      if (yA !== yB) return yA - yB;
      return (formatOrder[a.format || "TV"] ?? 6) - (formatOrder[b.format || "TV"] ?? 6);
    });

    // 6. Broadcast caching across ALL member IDs in the franchise!
    if (nodes && nodes.length > 1) {
      const entry = {
        nodes,
        timestamp: Date.now(),
      };
      for (const n of nodes) {
        if (n.id) {
          FRANCHISE_GRAPH_CACHE.set(String(n.id), entry);
          const num = parseInt(String(n.id).replace(/\D/g, ""), 10);
          if (!isNaN(num) && num > 0) {
            FRANCHISE_GRAPH_CACHE.set(num, entry);
          }
        }
        if ((n as any).idMal) {
          FRANCHISE_GRAPH_CACHE.set(`mal-${(n as any).idMal}`, entry);
        }
      }
      if (cleanId) FRANCHISE_GRAPH_CACHE.set(cleanId, entry);
      if (!isNaN(targetNumId) && targetNumId > 0) FRANCHISE_GRAPH_CACHE.set(targetNumId, entry);
      if (tmdbId) FRANCHISE_GRAPH_CACHE.set(`tmdb-${tmdbId}`, entry);
    }

    return Response.json({
      success: true,
      data: { franchiseNodes: nodes || [] },
    }, { headers: watchOrderCacheHeaders });
  } catch (error) {
    console.error("[Watch Order API Route Error]:", error);
    return Response.json({
      success: true,
      data: { franchiseNodes: [] },
    }, { headers: watchOrderCacheHeaders });
  }
}
