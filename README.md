# Climate-Twin Map

An interactive global explorer for identifying climate affinities between cities. Select a city, compare its climate profile with more than 235,000 locations, and discover places with similar environmental conditions.

The application visualizes similarity across a world map and lets users adjust the relative weight of temperature, rainfall, humidity, solar energy, daylight, cloud cover, and wind. It includes geographic filters, city and country comparisons, and map exports.

## Approach

Daily and hourly weather data are valuable for studying individual events, but can be unnecessarily granular for large-scale exploration and comparison. This project starts from a weekly aggregated data layer: it reduces short-term noise while retaining seasonal patterns and meaningful differences between locations.

For the web experience, profiles are optimized into 26 biweekly periods per variable. The model can compare the same calendar period or align equivalent seasons across hemispheres with a six-month shift.

## Data

- Coverage: weekly aggregated weather observations from 2016 to 2025.
- Scope: locations worldwide.
- Source: [Global Weekly Weather Averages by City (2016-2025)](https://www.kaggle.com/datasets/quingaete/worldwide-average-climate-by-week-20162025), a dataset created and published by [Quin Gaete](https://www.kaggle.com/quingaete).
- Source dataset license: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The files in `data/` are a compact, browser-ready version derived from the original dataset; they are not the raw Kaggle dataset.

## Scope and limitations

This tool is intended for exploration, visualization, education, and comparative analysis. Weekly aggregation smooths day-to-day variation and may conceal short-lived or extreme events. The 2016-2025 period is not a formal climatological normal.

Results are starting points for researching territorial references or bioclimatic strategies. They do not replace local meteorological, seismic, regulatory, cultural, or site-specific studies.

## Basemap

The map uses tiles from [OpenStreetMap](https://www.openstreetmap.org/copyright). Copyright OpenStreetMap contributors.
