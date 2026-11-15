/**
 * 扩展入口：默认导出必须是 WorldDefinition。
 * package.json 里 cortico.kind = world、cortico.api = 6、world id = `map`。
 *
 * **world id 必须是 `map`**：装了启用之后 `worlds.map.enabled` 才会是 true，
 * 「鱼的每一天」那边的 `maplink`（另一个会话做）就靠读这一个字段判断要不要
 * 在「自己的时间」里加一行 `map_places → map_look`。改名就断了那条契约。
 */
import definition, { mapDefinition } from './definition.js';

export default definition;
export { mapDefinition };
export {
  MAP_TOOL_DECLS, MapWorld, configCandidates, decodeDataUrl, readImggenEnabled, readWorldEnabled,
  sniffImage,
} from './world.js';
export { ID as MAP_WORLD_ID, DEFAULTS as MAP_DEFAULTS, LABEL as MAP_LABEL } from './config.js';
export {
  KIND_LABEL, KINDS, TERRAINS, coverName, findPlace, findTerrain, hasFunVenue, hasScene, isSafeId,
  isTerrain, normalizeKind, normalizePlace, slugFor, terrainPlaces,
} from './places.js';
export {
  MAX_PLACES, addPlace, applyTerrain, applyTerrainSelection, editPlace, kindLabelOf, listPlaces,
  newState, normalizeState, placeById, placeView, removePlace, resolvePlace, setCover, summaryOf,
} from './state.js';
