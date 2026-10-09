import { GALLERY_ROUTES, type GalleryRouteId } from './manifest'

/**
 * Gallery URL for a scenario and hash route. DOM-free so specs can use it in Node.
 *
 * `galleryUrl('shell-connected')` → `/?scenario=shell-connected#/app`
 * `galleryUrl('history-error', 'app', 'http://localhost:5199')` →
 * `http://localhost:5199/?scenario=history-error#/app`
 */
export function galleryUrl(scenario: string, route: GalleryRouteId = 'app', baseUrl = ''): string {
  const prefix = baseUrl ? baseUrl.replace(/\/+$/, '') : ''
  return `${prefix}/?scenario=${encodeURIComponent(scenario)}${GALLERY_ROUTES[route]}`
}
