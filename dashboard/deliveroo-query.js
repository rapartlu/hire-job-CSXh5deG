// Deliveroo getHomeFeed GraphQL query and default variables.
// Used by the /api/search endpoint to fetch restaurant listings per area.

const QUERY = `
  query getHomeFeed(
    $ui_actions: [UIActionType!]
    $ui_blocks: [UIBlockType!]
    $ui_controls: [UIControlType!]
    $ui_features: [UIFeatureType!]
    $ui_layouts: [UILayoutType!]
    $ui_layout_carousel_styles: [UILayoutCarouselStyle!]
    $ui_lines: [UILineType!]
    $ui_targets: [UITargetType!]
    $ui_themes: [UIThemeType!]
    $fulfillment_methods: [FulfillmentMethod!]
    $location: LocationInput!
    $url: String
    $options: SearchOptionsInput
    $uuid: String!
  ) {
    results: search(
      location: $location
      options: $options
      url: $url
      capabilities: {
        ui_actions: $ui_actions
        ui_blocks: $ui_blocks
        ui_controls: $ui_controls
        ui_features: $ui_features
        ui_layouts: $ui_layouts
        ui_layout_carousel_styles: $ui_layout_carousel_styles
        ui_lines: $ui_lines
        ui_targets: $ui_targets
        ui_themes: $ui_themes
        fulfillment_methods: $fulfillment_methods
      }
      uuid: $uuid
    ) {
      layoutGroups: ui_layout_groups {
        id
        data: ui_layouts {
          typeName: __typename
          ... on UILayoutCarousel {
            blocks: ui_blocks {
              typeName: __typename
              ... on UICard {
                target {
                  typeName: __typename
                  ... on UITargetRestaurant {
                    restaurant {
                      id
                      name
                      links { self { href } }
                    }
                  }
                }
                uiContent: properties {
                  default {
                    uiLines: ui_lines {
                      typeName: __typename
                      ... on UITitleLine { text }
                      ... on UITextLine {
                        spans: ui_spans {
                          typeName: __typename
                          ... on UISpanText { text }
                        }
                      }
                      ... on UIBulletLine {
                        spans: ui_spans {
                          typeName: __typename
                          ... on UISpanText { text }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          ... on UILayoutList {
            blocks: ui_blocks {
              typeName: __typename
              ... on UICard {
                target {
                  typeName: __typename
                  ... on UITargetRestaurant {
                    restaurant {
                      id
                      name
                      links { self { href } }
                    }
                  }
                }
                uiContent: properties {
                  default {
                    uiLines: ui_lines {
                      typeName: __typename
                      ... on UITitleLine { text }
                      ... on UITextLine {
                        spans: ui_spans {
                          typeName: __typename
                          ... on UISpanText { text }
                        }
                      }
                      ... on UIBulletLine {
                        spans: ui_spans {
                          typeName: __typename
                          ... on UISpanText { text }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      meta {
        restaurantCount: restaurant_count { results location }
        location {
          cityName: city_name
          neighborhoodName: neighborhood_name
          geohash
          lat
          lon
        }
      }
    }
  }
`;

// Default capability variables - these match what the Deliveroo web app sends
const DEFAULT_VARS = {
  ui_controls: ['APPLIED_FILTER', 'FILTER', 'SORT', 'TABS'],
  ui_layout_carousel_styles: ['DEFAULT', 'PARTNER_HEADING'],
  ui_lines: ['TITLE', 'TEXT', 'BULLET'],
  ui_targets: ['PARAMS', 'RESTAURANT', 'MENU_ITEM', 'WEB_PAGE', 'DEEP_LINK', 'EDITORIAL_CONTENT'],
  fulfillment_methods: ['DELIVERY', 'COLLECTION'],
  options: {
    query: '',
    web_column_count: 4,
    fulfillment_include_asap_days: true,
  },
  ui_actions: [
    'CHANGE_DELIVERY_TIME', 'CLEAR_FILTERS', 'NO_DELIVERY_YET', 'SHOWCASE_PICKUP',
    'TOGGLE_FAVOURITE', 'SHOW_PICKUP', 'SHOW_DELIVERY', 'REFRESH',
  ],
  ui_features: [
    'UNAVAILABLE_RESTAURANTS', 'LIMIT_QUERY_RESULTS', 'UI_CARD_BORDER',
    'UI_CAROUSEL_COLOR', 'UI_PROMOTION_TAG', 'UI_BACKGROUND',
    'SCHEDULED_RANGES', 'UI_SPAN_TAGS', 'UI_CARD_BADGES',
    'TEXT_SEARCH_COMBINED_VIEW',
  ],
  ui_themes: [
    'CARD_LARGE', 'CARD_LARGE_V2', 'CARD_MEDIUM', 'CARD_MEDIUM_V2',
    'CARD_MEDIUM_HORIZONTAL', 'CARD_SMALL', 'CARD_SMALL_DIAGONAL',
    'CARD_SMALL_HORIZONTAL', 'CARD_WIDE', 'CARD_TALL', 'CARD_TALL_GRADIENT',
    'CARD_ROW', 'MODAL_DEFAULT',
  ],
  ui_layouts: ['LIST', 'CAROUSEL'],
  ui_blocks: ['BANNER', 'CARD', 'SHORTCUT', 'BUTTON', 'MERCHANDISING_CARD', 'ROO_BLOCK'],
};

module.exports = { QUERY, DEFAULT_VARS };
