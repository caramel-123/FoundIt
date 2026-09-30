# Scale plan

Numbers are estimates. Check current Supabase and Gemini pricing before relying on them.

## Load assumptions
| Stage | Users | New posts per day | Photo size after re-encode |
|---|---|---|---|
| Pilot | 500 | 20 | 150 to 300 KB (WebP, 1600px cap) |
| Campus | 5,000 | 150 | same |
| Multi-campus | 50,000 | 1,500 | same |

## Bottlenecks
1. Photos are stored as data URLs inside the items table (src/lib/image.ts). At about
   250 KB each, a 500 MB database holds roughly 2,000 photos. At campus scale this
   fills in weeks. This breaks first.
2. Feed queries load every item. Past a few thousand items the feed needs pagination.
3. AI caption import and student verification call the Gemini API per use; costs grow
   with usage and need a rate limit.
4. Realtime subscriptions on every table grow with concurrent users.

## Costs (monthly, rough)
| Users | Supabase | Gemini API | Total |
|---|---|---|---|
| 100 | Free tier | Free tier | 0 |
| 1,000 | Free tier until photo storage fills, then Pro (about 25 USD) | Low | about 25 USD |
| 10,000 | Pro plus storage and bandwidth | Moderate | about 50 to 100 USD |

## Stages
1. Pilot: current setup.
2. Campus: move photos to Supabase Storage with thumbnails, paginate the feed,
   archive released items after 90 days, rate limit AI calls per user.
3. Multi-campus: campus id on every row with RLS per campus, staff tools per office,
   moderation queue, and a CDN for images.
