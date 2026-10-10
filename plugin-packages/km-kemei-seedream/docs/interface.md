# KM 可美 Seedream 5.0 接口

## 来源与范围

- [供应商图像文档](https://token.xinhankr.com/docs/quickstart/doc0002)，公开文档 `volc-image`：OpenAI 兼容端点、Pro 的限制与默认值。
- [火山引擎 Image generation API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh&redirect=1)：Pro / Flash 的精确模型 ID、尺寸、参考图、格式和能力限制。
- 供应商模型市场确认两个精确模型 ID 可用。市场计费档不是参考图或组图数量上限。

## 请求

`POST https://token.xinhankr.com/v1/images/generations`，JSON，渠道 API Key 作为 Bearer Token。

```json
{
  "model": "doubao-seedream-5-0-pro-260628",
  "prompt": "暖色书房中的橘猫，写实照片，正方形构图",
  "n": 1,
  "size": "2048x2048",
  "response_format": "url",
  "output_format": "jpeg",
  "watermark": false,
  "background": "opaque"
}
```

Flash 使用 `doubao-seedream-5-0-flash-260915`。图生图仍使用同一端点；参考图映射为 `image`，单图是字符串，多图是数组，保持输入顺序，支持 URL / Base64。最多 10 张，每张不超过 30 MB。官方还要求参考图边长大于 14、总像素 196–36000000、比例 1:16–16:1；这些条件需素材本身满足。没有蒙版接口。

`size` 支持 `1K` / `1.5K` / `2K`，或像素字符串。空值 / auto 默认 2K；宿主比例值映射为官方 2K 像素。自定义总像素 921600–4624220，比例 1:16–16:1。宿主交互控件还保留全站的 16px 步长、最长边 3840 与 3:1 比例约束。提示词 32000 字符是宿主限制，未声称是供应商的上限。

| 比例 | 1K | 1.5K | 2K |
| --- | --- | --- | --- |
| 1:1 | 1024x1024 | 1536x1536 | 2048x2048 |
| 4:3 | 1152x864 | 1792x1344 | 2368x1776 |
| 3:4 | 864x1152 | 1344x1792 | 1776x2368 |
| 16:9 | 1424x800 | 2048x1152 | 2816x1584 |
| 9:16 | 800x1424 | 1152x2048 | 1584x2816 |
| 3:2 | 1248x832 | 1872x1248 | 2496x1664 |
| 2:3 | 832x1248 | 1248x1872 | 1664x2496 |
| 21:9 | 1568x672 | 2352x1008 | 3136x1344 |

## 命名空间扩展

`providerOptions.km-kemei-seedream`：

- `response_format`：url（默认）/ b64_json。
- `output_format`：jpeg（默认）/ png。
- `watermark`：false（默认）/ true。
- `background`：opaque（默认）/ transparent。透明只用于一张带 alpha 的输入图，且输出 png；插件校验单图与 png 条件，alpha 条件由供应商检查。宿主通用透明开关默认关闭，避免把任意文生图伪装成此能力。
- `layer_decomposition`：布尔值，仅一张输入图，尺寸使用档位或 auto；此时允许空提示词，保存全部图层，不按 n=1 截断。

Pro / Flash 不支持 sequential_image_generation、组图、联网搜索、流式输出。插件拒绝相关扩展字段，不发送通用 quality、resolution、seed。

## 响应与失败

同步响应中的 `data[]` 全部提取，兼容 url / b64_json，并透传 usage。供应商 URL 有有效期，宿主必须持久化结果。HTTP 错误由宿主处理，JSON 的 error.code / error.message 映射为失败；不以空结果冒充成功。

安装包不携带渠道密钥；管理员通过正常插件安装机制启用，再给渠道模型选择此协议。模型价格与启用状态由管理员独立配置。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "km-kemei-seedream",
  "name": "KM 可美 Seedream 5.0",
  "version": "1.0.0",
  "author": "KM 可美 / 影绘",
  "description": "适配可美 Seedream 5.0 Pro 与 Flash，单张生成、参考图与全部结果提取。",
  "enabled": true,
  "installable": true,
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "API Key",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "km-kemei-seedream",
        "label": "KM 可美 Seedream 5.0",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://token.xinhankr.com",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "精确 ID：doubao-seedream-5-0-pro-260628 / doubao-seedream-5-0-flash-260915。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词；宿主限制 32000 字符。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "n=1",
            "description": "仅单张生成；图层分解返回的所有图层均保存。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size",
            "description": "默认 2048x2048（2K、1:1）；支持 1K / 1.5K / 2K、八种比例或合法像素尺寸。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "image",
            "description": "最多 10 张；URL / Base64；不支持蒙版。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "providerOptions.km-kemei-seedream",
            "description": "可选 response_format / output_format / watermark / background / layer_decomposition。"
          }
        ],
        "validations": [
          {
            "assert": {
              "$in": [
                {
                  "$ref": "request.model"
                },
                [
                  "doubao-seedream-5-0-pro-260628",
                  "doubao-seedream-5-0-flash-260915"
                ]
              ]
            },
            "message": "此协议只适用于可美 Seedream 5.0 Pro / Flash 的已确认模型 ID。"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$ref": "request.imageCount"
                },
                1
              ]
            },
            "message": "Seedream 5.0 Pro / Flash 仅支持单张生成，n 只能为 1。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$gt": [
                    {
                      "$len": {
                        "$trim": {
                          "$ref": "request.prompt"
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$eq": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.km-kemei-seedream.layer_decomposition"
                        },
                        false
                      ]
                    },
                    true
                  ]
                }
              ]
            },
            "message": "提示词不能为空；仅图层分解模式可省略提示词。"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$ref": "request.prompt"
                  }
                },
                32000
              ]
            },
            "message": "提示词超过宿主配置的 32000 字符上限。"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$ref": "request.images"
                  }
                },
                10
              ]
            },
            "message": "Seedream 5.0 参考图最多 10 张。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.images"
                      },
                      "as": "media",
                      "where": {
                        "$eq": [
                          {
                            "$ref": "media.role"
                          },
                          "mask"
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "此协议不支持蒙版编辑。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.images"
                      },
                      "as": "media",
                      "where": {
                        "$gt": [
                          {
                            "$coalesce": [
                              {
                                "$ref": "media.metadata.bytes"
                              },
                              0
                            ]
                          },
                          31457280
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "单张参考图不得超过 30 MB。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$in": [
                    {
                      "$lower": {
                        "$trim": {
                          "$coalesce": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "2k"
                          ]
                        }
                      }
                    },
                    [
                      "",
                      "auto",
                      "1k",
                      "1.5k",
                      "2k",
                      "1:1",
                      "4:3",
                      "3:4",
                      "16:9",
                      "9:16",
                      "3:2",
                      "2:3",
                      "21:9"
                    ]
                  ]
                },
                {
                  "$and": [
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$split": [
                              {
                                "$lower": {
                                  "$trim": {
                                    "$coalesce": [
                                      {
                                        "$ref": "request.aspectRatio"
                                      },
                                      "2k"
                                    ]
                                  }
                                }
                              },
                              "x"
                            ]
                          }
                        },
                        2
                      ]
                    },
                    {
                      "$gt": [
                        {
                          "$toInt": {
                            "$at": [
                              {
                                "$split": [
                                  {
                                    "$lower": {
                                      "$trim": {
                                        "$coalesce": [
                                          {
                                            "$ref": "request.aspectRatio"
                                          },
                                          "2k"
                                        ]
                                      }
                                    }
                                  },
                                  "x"
                                ]
                              },
                              0
                            ]
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$gt": [
                        {
                          "$toInt": {
                            "$at": [
                              {
                                "$split": [
                                  {
                                    "$lower": {
                                      "$trim": {
                                        "$coalesce": [
                                          {
                                            "$ref": "request.aspectRatio"
                                          },
                                          "2k"
                                        ]
                                      }
                                    }
                                  },
                                  "x"
                                ]
                              },
                              1
                            ]
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$gte": [
                        {
                          "$multiply": [
                            {
                              "$toInt": {
                                "$at": [
                                  {
                                    "$split": [
                                      {
                                        "$lower": {
                                          "$trim": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.aspectRatio"
                                              },
                                              "2k"
                                            ]
                                          }
                                        }
                                      },
                                      "x"
                                    ]
                                  },
                                  0
                                ]
                              }
                            },
                            {
                              "$toInt": {
                                "$at": [
                                  {
                                    "$split": [
                                      {
                                        "$lower": {
                                          "$trim": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.aspectRatio"
                                              },
                                              "2k"
                                            ]
                                          }
                                        }
                                      },
                                      "x"
                                    ]
                                  },
                                  1
                                ]
                              }
                            }
                          ]
                        },
                        921600
                      ]
                    },
                    {
                      "$lte": [
                        {
                          "$multiply": [
                            {
                              "$toInt": {
                                "$at": [
                                  {
                                    "$split": [
                                      {
                                        "$lower": {
                                          "$trim": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.aspectRatio"
                                              },
                                              "2k"
                                            ]
                                          }
                                        }
                                      },
                                      "x"
                                    ]
                                  },
                                  0
                                ]
                              }
                            },
                            {
                              "$toInt": {
                                "$at": [
                                  {
                                    "$split": [
                                      {
                                        "$lower": {
                                          "$trim": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.aspectRatio"
                                              },
                                              "2k"
                                            ]
                                          }
                                        }
                                      },
                                      "x"
                                    ]
                                  },
                                  1
                                ]
                              }
                            }
                          ]
                        },
                        4624220
                      ]
                    },
                    {
                      "$lte": [
                        {
                          "$toInt": {
                            "$at": [
                              {
                                "$split": [
                                  {
                                    "$lower": {
                                      "$trim": {
                                        "$coalesce": [
                                          {
                                            "$ref": "request.aspectRatio"
                                          },
                                          "2k"
                                        ]
                                      }
                                    }
                                  },
                                  "x"
                                ]
                              },
                              0
                            ]
                          }
                        },
                        {
                          "$multiply": [
                            {
                              "$toInt": {
                                "$at": [
                                  {
                                    "$split": [
                                      {
                                        "$lower": {
                                          "$trim": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.aspectRatio"
                                              },
                                              "2k"
                                            ]
                                          }
                                        }
                                      },
                                      "x"
                                    ]
                                  },
                                  1
                                ]
                              }
                            },
                            16
                          ]
                        }
                      ]
                    },
                    {
                      "$lte": [
                        {
                          "$toInt": {
                            "$at": [
                              {
                                "$split": [
                                  {
                                    "$lower": {
                                      "$trim": {
                                        "$coalesce": [
                                          {
                                            "$ref": "request.aspectRatio"
                                          },
                                          "2k"
                                        ]
                                      }
                                    }
                                  },
                                  "x"
                                ]
                              },
                              1
                            ]
                          }
                        },
                        {
                          "$multiply": [
                            {
                              "$toInt": {
                                "$at": [
                                  {
                                    "$split": [
                                      {
                                        "$lower": {
                                          "$trim": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.aspectRatio"
                                              },
                                              "2k"
                                            ]
                                          }
                                        }
                                      },
                                      "x"
                                    ]
                                  },
                                  0
                                ]
                              }
                            },
                            16
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "size 必须为 1K / 1.5K / 2K 或合法像素尺寸；像素总数 921600–4624220，比例 1:16–16:1。"
          },
          {
            "assert": {
              "$in": [
                {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.km-kemei-seedream.response_format"
                    },
                    "url"
                  ]
                },
                [
                  "url",
                  "b64_json"
                ]
              ]
            },
            "message": "response_format 仅支持 url / b64_json。"
          },
          {
            "assert": {
              "$in": [
                {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.km-kemei-seedream.output_format"
                    },
                    "jpeg"
                  ]
                },
                [
                  "jpeg",
                  "png"
                ]
              ]
            },
            "message": "output_format 仅支持 jpeg / png。"
          },
          {
            "assert": {
              "$in": [
                {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.km-kemei-seedream.background"
                    },
                    "opaque"
                  ]
                },
                [
                  "opaque",
                  "transparent"
                ]
              ]
            },
            "message": "background 仅支持 opaque / transparent。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$ne": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.km-kemei-seedream.background"
                        },
                        "opaque"
                      ]
                    },
                    "transparent"
                  ]
                },
                {
                  "$and": [
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$ref": "request.images"
                          }
                        },
                        1
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.km-kemei-seedream.output_format"
                            },
                            "jpeg"
                          ]
                        },
                        "png"
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "透明背景仅用于一张带透明通道的参考图，输出必须为 png。"
          },
          {
            "assert": {
              "$in": [
                {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.km-kemei-seedream.layer_decomposition"
                    },
                    false
                  ]
                },
                [
                  true,
                  false
                ]
              ]
            },
            "message": "layer_decomposition 必须为布尔值。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$ne": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.km-kemei-seedream.layer_decomposition"
                        },
                        false
                      ]
                    },
                    true
                  ]
                },
                {
                  "$and": [
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$ref": "request.images"
                          }
                        },
                        1
                      ]
                    },
                    {
                      "$in": [
                        {
                          "$lower": {
                            "$trim": {
                              "$coalesce": [
                                {
                                  "$ref": "request.aspectRatio"
                                },
                                "2k"
                              ]
                            }
                          }
                        },
                        [
                          "",
                          "auto",
                          "1k",
                          "1.5k",
                          "2k"
                        ]
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "图层分解仅支持一张参考图，size 使用 1K / 1.5K / 2K / auto 档位。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.sequential_image_generation"
                },
                null
              ]
            },
            "message": "sequential_image_generation 不适用于 Seedream 5.0 Pro / Flash，已拒绝请求。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.sequential_image_generation_options"
                },
                null
              ]
            },
            "message": "sequential_image_generation_options 不适用于 Seedream 5.0 Pro / Flash，已拒绝请求。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.web_search"
                },
                null
              ]
            },
            "message": "web_search 不适用于 Seedream 5.0 Pro / Flash，已拒绝请求。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.stream"
                },
                null
              ]
            },
            "message": "stream 不适用于 Seedream 5.0 Pro / Flash，已拒绝请求。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.tools"
                },
                null
              ]
            },
            "message": "tools 不适用于 Seedream 5.0 Pro / Flash，已拒绝请求。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/images/generations",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "n": 1,
            "size": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.km-kemei-seedream.layer_decomposition"
                        },
                        false
                      ]
                    },
                    true
                  ]
                },
                "then": {
                  "$if": {
                    "condition": {
                      "$in": [
                        {
                          "$lower": {
                            "$trim": {
                              "$coalesce": [
                                {
                                  "$ref": "request.aspectRatio"
                                },
                                "2k"
                              ]
                            }
                          }
                        },
                        [
                          "",
                          "auto"
                        ]
                      ]
                    },
                    "then": "auto",
                    "else": {
                      "$switch": {
                        "cases": [
                          {
                            "when": {
                              "$in": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                [
                                  "",
                                  "auto",
                                  "2k"
                                ]
                              ]
                            },
                            "then": "2K"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "1k"
                              ]
                            },
                            "then": "1K"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "1.5k"
                              ]
                            },
                            "then": "1.5K"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "1:1"
                              ]
                            },
                            "then": "2048x2048"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "4:3"
                              ]
                            },
                            "then": "2368x1776"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "3:4"
                              ]
                            },
                            "then": "1776x2368"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "16:9"
                              ]
                            },
                            "then": "2816x1584"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "9:16"
                              ]
                            },
                            "then": "1584x2816"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "3:2"
                              ]
                            },
                            "then": "2496x1664"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "2:3"
                              ]
                            },
                            "then": "1664x2496"
                          },
                          {
                            "when": {
                              "$eq": [
                                {
                                  "$lower": {
                                    "$trim": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        "2k"
                                      ]
                                    }
                                  }
                                },
                                "21:9"
                              ]
                            },
                            "then": "3136x1344"
                          }
                        ],
                        "default": {
                          "$lower": {
                            "$trim": {
                              "$coalesce": [
                                {
                                  "$ref": "request.aspectRatio"
                                },
                                "2k"
                              ]
                            }
                          }
                        }
                      }
                    }
                  }
                },
                "else": {
                  "$switch": {
                    "cases": [
                      {
                        "when": {
                          "$in": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            [
                              "",
                              "auto",
                              "2k"
                            ]
                          ]
                        },
                        "then": "2K"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "1k"
                          ]
                        },
                        "then": "1K"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "1.5k"
                          ]
                        },
                        "then": "1.5K"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "1:1"
                          ]
                        },
                        "then": "2048x2048"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "4:3"
                          ]
                        },
                        "then": "2368x1776"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "3:4"
                          ]
                        },
                        "then": "1776x2368"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "16:9"
                          ]
                        },
                        "then": "2816x1584"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "9:16"
                          ]
                        },
                        "then": "1584x2816"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "3:2"
                          ]
                        },
                        "then": "2496x1664"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "2:3"
                          ]
                        },
                        "then": "1664x2496"
                      },
                      {
                        "when": {
                          "$eq": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$coalesce": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2k"
                                  ]
                                }
                              }
                            },
                            "21:9"
                          ]
                        },
                        "then": "3136x1344"
                      }
                    ],
                    "default": {
                      "$lower": {
                        "$trim": {
                          "$coalesce": [
                            {
                              "$ref": "request.aspectRatio"
                            },
                            "2k"
                          ]
                        }
                      }
                    }
                  }
                }
              }
            },
            "image": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$len": {
                          "$ref": "request.images"
                        }
                      },
                      1
                    ]
                  },
                  "then": {
                    "$first": {
                      "$map": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  },
                  "else": {
                    "$map": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                }
              }
            },
            "response_format": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.response_format"
                },
                "url"
              ]
            },
            "output_format": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.output_format"
                },
                "jpeg"
              ]
            },
            "watermark": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.watermark"
                },
                false
              ]
            },
            "background": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.km-kemei-seedream.background"
                },
                "opaque"
              ]
            },
            "layer_decomposition": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.km-kemei-seedream.layer_decomposition"
              }
            }
          }
        },
        "response": {
          "status": "succeeded",
          "images": {
            "$ref": "response.data"
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code",
            "error.message"
          ],
          "messagePaths": [
            "error.message"
          ]
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
