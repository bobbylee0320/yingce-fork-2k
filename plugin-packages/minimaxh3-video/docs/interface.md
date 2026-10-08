# 接口合同

## 配置和请求

`apiKey` 为渠道密钥，由宿主后端注入 Bearer Header。创建使用 JSON `POST /v1/videos/generations`，成功返回 HTTP 202 和 `task_id`；不能把 Ark `content`、`image_urls`、`size` 或 `aspect_ratio` 发给该端点。

| 参数 | 画布映射与规则 |
| --- | --- |
| `model` | 模型 ID；必须对应 `/v1/models` 返回的模型。 |
| `prompt` | 1–8000 字符；`@名称` 必须与素材 name 一致。 |
| `images` | 图像引用；按 order 排序，保留 name 和明确帧角色。 |
| `videos` | 视频引用；单个 ≤20MB，最多 10 个。 |
| `audios` | 音频引用；单个 ≤20MB、≤15 秒，最多 10 个。 |
| `ratio` | 统一 aspectRatio，默认 16:9；不能使用 adaptive。 |
| `duration` | 统一 duration，默认 5 秒；合法时长以模型 caps.dur 为准。 |
| `video_resolution` | 统一 resolution，转为小写；默认 720p，可选 480p/720p/1080p/2k/4k/2160p，实际按 caps.res 配置。 |
| `function_mode` | `providerOptions.minimaxh3-video.function_mode`，三种模式见下表。 |
| `channel` | `providerOptions.minimaxh3-video.channel`；上游渠道 name，例如 default/lumen，省略使用上游默认渠道。 |
| `face` | `providerOptions.minimaxh3-video.face`；例如 `{"enabled":true,"mode":"light"}`。省略保持原图，关闭用 `{"enabled":false}`。 |

| 模式 | 字段和选择规则 |
| --- | --- |
| `first_last_frames` | 仅发送 `first_frame_url`、`end_frame_url`。没有参考素材时为文生视频；明确帧角色优先，未标角色的一/两张图片按排序映射首/尾帧。尾帧必须同时有首帧。 |
| `multi_frame` | 明确设置 function_mode，发送 `multi_frames` URL 数组，2–10 张关键帧；禁止视频和音频。 |
| `omni_reference` | 发送 `materials`：每项 `{type,url,name}`。有 reference_image、视频或音频时默认使用该模式；无角色图片也可显式选择该模式。最多 30 张图片、10 视频、10 音频，实际受模型 caps.materials 限制。不能混入明确首尾帧。 |

三种模式互斥，请勿把首尾帧选择与全模态参考素材混用。首尾帧模式支持 first_frame/first 和 last_frame/end_frame/last/tail 角色。媒体必须先上传为供应商可访问的 HTTP/HTTPS URL；Data URL 不会直接发送。宿主继续执行资源解析和出站安全校验。已知素材字节数、音频时长超过限制时在本地拒绝，未提供元数据时由上游校验。

## 全模态示例

```json
{
  "model": "minimaxH3",
  "prompt": "@角色A 在 @场景 里行走，背景音乐用 @配乐",
  "function_mode": "omni_reference",
  "ratio": "16:9",
  "duration": 8,
  "video_resolution": "720p",
  "materials": [
    {"type":"image","name":"角色A","url":"https://example.com/actor.jpg"},
    {"type":"video","name":"场景","url":"https://example.com/street.mp4"},
    {"type":"audio","name":"配乐","url":"https://example.com/music.mp3"}
  ]
}
```

## 异步状态和响应

查询使用 `GET /v1/tasks/{taskId}`，接收 UUID 或 cgt ID。pending/submitted 映射等待；generating/post_processing/finalizing 映射进行中；success 映射完成；failed 映射失败。`fail_reason` 原样作为失败原因；错误体 `error` 保留失败语义。中间态携带 URL 也不会提前下载。

完成后仅调用带 Bearer 鉴权的 `GET /v1/tasks/{taskId}/download?index=0`，交给宿主媒体保存流程。上游按本地高清文件 → source_urls → result_urls 的顺序返回字节，因此预览 URL 不会覆盖高清原片；不将 CDN 临时链接作为已保存资源。无文件、过期、上游下载失败或空响应会如实失败，不能伪装成生成成功。

文档未给出视频任务取消接口，插件不声明取消端点。素材数量、时长、分辨率和模式按当前模型 caps 配置，本插件不会推断或替换模型。内置发布和协议专项测试可验证请求及状态合同，真实付费生成仍需用户配置渠道后验收。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "minimaxh3-video",
  "name": "MINIMAXH3 全模态视频",
  "version": "1.0.0",
  "author": "MINIMAXH3 / 影策",
  "description": "MINIMAXH3 首尾帧、多帧和图片/视频/音频全模态生成，使用鉴权下载端点保存高清结果。",
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
        "id": "minimaxh3-video",
        "label": "MINIMAXH3 全模态视频",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://dnyovzpgyokm.sealosbja.site",
        "requiresPublicMediaUrls": true,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "validations": [
          {
            "assert": {
              "$gt": [
                {
                  "$len": {
                    "$trim": {
                      "$ref": "request.model"
                    }
                  }
                },
                0
              ]
            },
            "message": "请填写 GET /v1/models 返回的模型 ID。"
          },
          {
            "assert": {
              "$and": [
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
                  "$lte": [
                    {
                      "$len": {
                        "$ref": "request.prompt"
                      }
                    },
                    8000
                  ]
                }
              ]
            },
            "message": "提示词不能为空，且不能超过 8000 字符。"
          },
          {
            "assert": {
              "$in": [
                {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                    },
                    {
                      "$if": {
                        "condition": {
                          "$gt": [
                            {
                              "$add": [
                                {
                                  "$len": {
                                    "$sortByOrder": {
                                      "$ref": "request.videos"
                                    }
                                  }
                                },
                                {
                                  "$len": {
                                    "$sortByOrder": {
                                      "$ref": "request.audios"
                                    }
                                  }
                                },
                                {
                                  "$len": {
                                    "$filter": {
                                      "from": {
                                        "$sortByOrder": {
                                          "$ref": "request.images"
                                        }
                                      },
                                      "as": "media",
                                      "where": {
                                        "$eq": [
                                          {
                                            "$ref": "media.role"
                                          },
                                          "reference_image"
                                        ]
                                      }
                                    }
                                  }
                                }
                              ]
                            },
                            0
                          ]
                        },
                        "then": "omni_reference",
                        "else": "first_last_frames"
                      }
                    }
                  ]
                },
                [
                  "first_last_frames",
                  "multi_frame",
                  "omni_reference"
                ]
              ]
            },
            "message": "不支持的视频模式。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$concatArrays": [
                          {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          {
                            "$sortByOrder": {
                              "$ref": "request.videos"
                            }
                          },
                          {
                            "$sortByOrder": {
                              "$ref": "request.audios"
                            }
                          }
                        ]
                      },
                      "as": "media",
                      "where": {
                        "$not": {
                          "$in": [
                            {
                              "$first": {
                                "$split": [
                                  {
                                    "$ref": "media.url"
                                  },
                                  "/"
                                ]
                              }
                            },
                            [
                              "https:",
                              "http:"
                            ]
                          ]
                        }
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "参考素材必须是可访问的 HTTP/HTTPS URL；请先上传素材。"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  }
                },
                30
              ]
            },
            "message": "图片素材最多 30 张；实际上限以模型 caps.materials 为准。"
          },
          {
            "assert": {
              "$and": [
                {
                  "$lte": [
                    {
                      "$len": {
                        "$sortByOrder": {
                          "$ref": "request.videos"
                        }
                      }
                    },
                    10
                  ]
                },
                {
                  "$lte": [
                    {
                      "$len": {
                        "$sortByOrder": {
                          "$ref": "request.audios"
                        }
                      }
                    },
                    10
                  ]
                }
              ]
            },
            "message": "视频和音频素材各最多 10 个；实际上限以模型 caps.materials 为准。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$concatArrays": [
                          {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          {
                            "$sortByOrder": {
                              "$ref": "request.videos"
                            }
                          },
                          {
                            "$sortByOrder": {
                              "$ref": "request.audios"
                            }
                          }
                        ]
                      },
                      "as": "media",
                      "where": {
                        "$gt": [
                          {
                            "$ref": "media.metadata.bytes"
                          },
                          20971520
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "单个参考素材不能超过 20MB。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.audios"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$gt": [
                          {
                            "$ref": "media.metadata.durationMs"
                          },
                          15000
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "参考音频不能超过 15 秒。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$eq": [
                      {
                        "$coalesce": [
                          {
                            "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                          },
                          {
                            "$if": {
                              "condition": {
                                "$gt": [
                                  {
                                    "$add": [
                                      {
                                        "$len": {
                                          "$sortByOrder": {
                                            "$ref": "request.videos"
                                          }
                                        }
                                      },
                                      {
                                        "$len": {
                                          "$sortByOrder": {
                                            "$ref": "request.audios"
                                          }
                                        }
                                      },
                                      {
                                        "$len": {
                                          "$filter": {
                                            "from": {
                                              "$sortByOrder": {
                                                "$ref": "request.images"
                                              }
                                            },
                                            "as": "media",
                                            "where": {
                                              "$eq": [
                                                {
                                                  "$ref": "media.role"
                                                },
                                                "reference_image"
                                              ]
                                            }
                                          }
                                        }
                                      }
                                    ]
                                  },
                                  0
                                ]
                              },
                              "then": "omni_reference",
                              "else": "first_last_frames"
                            }
                          }
                        ]
                      },
                      "first_last_frames"
                    ]
                  }
                },
                {
                  "$and": [
                    {
                      "$lte": [
                        {
                          "$len": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          }
                        },
                        2
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$sortByOrder": {
                              "$ref": "request.videos"
                            }
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$sortByOrder": {
                              "$ref": "request.audios"
                            }
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$eq": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "reference_image"
                                ]
                              }
                            }
                          }
                        },
                        0
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "首尾帧模式只允许最多两张帧图片；不能混用全模态参考素材。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$eq": [
                      {
                        "$coalesce": [
                          {
                            "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                          },
                          {
                            "$if": {
                              "condition": {
                                "$gt": [
                                  {
                                    "$add": [
                                      {
                                        "$len": {
                                          "$sortByOrder": {
                                            "$ref": "request.videos"
                                          }
                                        }
                                      },
                                      {
                                        "$len": {
                                          "$sortByOrder": {
                                            "$ref": "request.audios"
                                          }
                                        }
                                      },
                                      {
                                        "$len": {
                                          "$filter": {
                                            "from": {
                                              "$sortByOrder": {
                                                "$ref": "request.images"
                                              }
                                            },
                                            "as": "media",
                                            "where": {
                                              "$eq": [
                                                {
                                                  "$ref": "media.role"
                                                },
                                                "reference_image"
                                              ]
                                            }
                                          }
                                        }
                                      }
                                    ]
                                  },
                                  0
                                ]
                              },
                              "then": "omni_reference",
                              "else": "first_last_frames"
                            }
                          }
                        ]
                      },
                      "multi_frame"
                    ]
                  }
                },
                {
                  "$and": [
                    {
                      "$gte": [
                        {
                          "$len": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          }
                        },
                        2
                      ]
                    },
                    {
                      "$lte": [
                        {
                          "$len": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          }
                        },
                        10
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$sortByOrder": {
                              "$ref": "request.videos"
                            }
                          }
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$sortByOrder": {
                              "$ref": "request.audios"
                            }
                          }
                        },
                        0
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "多帧模式需要 2 到 10 张图片，不能混用视频或音频。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$eq": [
                      {
                        "$coalesce": [
                          {
                            "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                          },
                          {
                            "$if": {
                              "condition": {
                                "$gt": [
                                  {
                                    "$add": [
                                      {
                                        "$len": {
                                          "$sortByOrder": {
                                            "$ref": "request.videos"
                                          }
                                        }
                                      },
                                      {
                                        "$len": {
                                          "$sortByOrder": {
                                            "$ref": "request.audios"
                                          }
                                        }
                                      },
                                      {
                                        "$len": {
                                          "$filter": {
                                            "from": {
                                              "$sortByOrder": {
                                                "$ref": "request.images"
                                              }
                                            },
                                            "as": "media",
                                            "where": {
                                              "$eq": [
                                                {
                                                  "$ref": "media.role"
                                                },
                                                "reference_image"
                                              ]
                                            }
                                          }
                                        }
                                      }
                                    ]
                                  },
                                  0
                                ]
                              },
                              "then": "omni_reference",
                              "else": "first_last_frames"
                            }
                          }
                        ]
                      },
                      "omni_reference"
                    ]
                  }
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "first_frame",
                                "first",
                                "last_frame",
                                "end_frame",
                                "last",
                                "tail"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "全模态模式不能混用首尾帧；请取消帧选择，将图片作为参考素材。"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$eq": [
                      {
                        "$coalesce": [
                          {
                            "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                          },
                          {
                            "$if": {
                              "condition": {
                                "$gt": [
                                  {
                                    "$add": [
                                      {
                                        "$len": {
                                          "$sortByOrder": {
                                            "$ref": "request.videos"
                                          }
                                        }
                                      },
                                      {
                                        "$len": {
                                          "$sortByOrder": {
                                            "$ref": "request.audios"
                                          }
                                        }
                                      },
                                      {
                                        "$len": {
                                          "$filter": {
                                            "from": {
                                              "$sortByOrder": {
                                                "$ref": "request.images"
                                              }
                                            },
                                            "as": "media",
                                            "where": {
                                              "$eq": [
                                                {
                                                  "$ref": "media.role"
                                                },
                                                "reference_image"
                                              ]
                                            }
                                          }
                                        }
                                      }
                                    ]
                                  },
                                  0
                                ]
                              },
                              "then": "omni_reference",
                              "else": "first_last_frames"
                            }
                          }
                        ]
                      },
                      "first_last_frames"
                    ]
                  }
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "last_frame",
                                "end_frame",
                                "last",
                                "tail"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                {
                  "$gt": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "first_frame",
                                "first"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "尾帧需要同时指定首帧。"
          },
          {
            "assert": {
              "$and": [
                {
                  "$lte": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "first_frame",
                                "first"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    1
                  ]
                },
                {
                  "$lte": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "where": {
                            "$in": [
                              {
                                "$ref": "media.role"
                              },
                              [
                                "last_frame",
                                "end_frame",
                                "last",
                                "tail"
                              ]
                            ]
                          }
                        }
                      }
                    },
                    1
                  ]
                }
              ]
            },
            "message": "首帧和尾帧各只能指定一张图片。"
          },
          {
            "assert": {
              "$in": [
                {
                  "$lower": {
                    "$coalesce": [
                      {
                        "$ref": "request.output.resolution"
                      },
                      {
                        "$ref": "request.resolution"
                      },
                      "720p"
                    ]
                  }
                },
                [
                  "480p",
                  "720p",
                  "1080p",
                  "2k",
                  "4k",
                  "2160p"
                ]
              ]
            },
            "message": "不支持的 video_resolution；请按模型 caps.res 配置。"
          },
          {
            "assert": {
              "$ne": [
                {
                  "$coalesce": [
                    {
                      "$ref": "request.output.aspectRatio"
                    },
                    {
                      "$ref": "request.aspectRatio"
                    },
                    "16:9"
                  ]
                },
                "adaptive"
              ]
            },
            "message": "请使用明确的宽高比，接口不接受 adaptive。"
          }
        ],
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "mapping": "model",
            "description": "模型 ID 和能力以 GET /v1/models 的 caps 为准。",
            "required": true
          },
          {
            "name": "prompt",
            "type": "string",
            "mapping": "prompt",
            "description": "最多 8000 字符；@名称必须匹配对应素材 name。",
            "required": true
          },
          {
            "name": "images",
            "type": "media[]",
            "mapping": "images",
            "description": "图片参考或首尾帧；全模态上限 30 张，多帧上限 10 张。",
            "required": false
          },
          {
            "name": "videos",
            "type": "media[]",
            "mapping": "videos",
            "description": "参考视频最多 10 个，单个不超过 20MB。",
            "required": false
          },
          {
            "name": "audios",
            "type": "media[]",
            "mapping": "audios",
            "description": "参考音频最多 10 个，单个不超过 20MB、15 秒。",
            "required": false
          },
          {
            "name": "ratio",
            "type": "string",
            "mapping": "aspectRatio",
            "description": "明确的宽高比，如 16:9 或 9:16，默认 16:9。",
            "required": false
          },
          {
            "name": "duration",
            "type": "integer",
            "mapping": "duration",
            "description": "默认 5 秒；具体时长范围由模型 caps.dur 决定。",
            "required": false
          },
          {
            "name": "video_resolution",
            "type": "string",
            "mapping": "resolution",
            "description": "默认 720p；可选值按模型 caps.res 配置。",
            "required": false
          },
          {
            "name": "function_mode",
            "type": "string",
            "mapping": "providerOptions.minimaxh3-video.function_mode",
            "description": "可明确选模式；默认有参考图/视频/音频时全模态，其余首尾帧。",
            "required": false,
            "values": [
              "first_last_frames",
              "multi_frame",
              "omni_reference"
            ]
          },
          {
            "name": "channel",
            "type": "string",
            "mapping": "providerOptions.minimaxh3-video.channel",
            "description": "上游渠道 name，如 default、lumen；省略使用上游默认渠道。",
            "required": false
          },
          {
            "name": "face",
            "type": "object",
            "mapping": "providerOptions.minimaxh3-video.face",
            "description": "过脸配置，如 {enabled:true,mode:\"light\"}；省略按原图提交。",
            "required": false
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/videos/generations",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "function_mode": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                },
                {
                  "$if": {
                    "condition": {
                      "$gt": [
                        {
                          "$add": [
                            {
                              "$len": {
                                "$sortByOrder": {
                                  "$ref": "request.videos"
                                }
                              }
                            },
                            {
                              "$len": {
                                "$sortByOrder": {
                                  "$ref": "request.audios"
                                }
                              }
                            },
                            {
                              "$len": {
                                "$filter": {
                                  "from": {
                                    "$sortByOrder": {
                                      "$ref": "request.images"
                                    }
                                  },
                                  "as": "media",
                                  "where": {
                                    "$eq": [
                                      {
                                        "$ref": "media.role"
                                      },
                                      "reference_image"
                                    ]
                                  }
                                }
                              }
                            }
                          ]
                        },
                        0
                      ]
                    },
                    "then": "omni_reference",
                    "else": "first_last_frames"
                  }
                }
              ]
            },
            "ratio": {
              "$coalesce": [
                {
                  "$ref": "request.output.aspectRatio"
                },
                {
                  "$ref": "request.aspectRatio"
                },
                "16:9"
              ]
            },
            "duration": {
              "$coalesce": [
                {
                  "$ref": "request.output.duration"
                },
                {
                  "$ref": "request.duration"
                },
                5
              ]
            },
            "video_resolution": {
              "$lower": {
                "$coalesce": [
                  {
                    "$ref": "request.output.resolution"
                  },
                  {
                    "$ref": "request.resolution"
                  },
                  "720p"
                ]
              }
            },
            "channel": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.minimaxh3-video.channel"
              }
            },
            "face": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.minimaxh3-video.face"
              }
            },
            "first_frame_url": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                        },
                        {
                          "$if": {
                            "condition": {
                              "$gt": [
                                {
                                  "$add": [
                                    {
                                      "$len": {
                                        "$sortByOrder": {
                                          "$ref": "request.videos"
                                        }
                                      }
                                    },
                                    {
                                      "$len": {
                                        "$sortByOrder": {
                                          "$ref": "request.audios"
                                        }
                                      }
                                    },
                                    {
                                      "$len": {
                                        "$filter": {
                                          "from": {
                                            "$sortByOrder": {
                                              "$ref": "request.images"
                                            }
                                          },
                                          "as": "media",
                                          "where": {
                                            "$eq": [
                                              {
                                                "$ref": "media.role"
                                              },
                                              "reference_image"
                                            ]
                                          }
                                        }
                                      }
                                    }
                                  ]
                                },
                                0
                              ]
                            },
                            "then": "omni_reference",
                            "else": "first_last_frames"
                          }
                        }
                      ]
                    },
                    "first_last_frames"
                  ]
                },
                "then": {
                  "$coalesce": [
                    {
                      "$first": {
                        "$map": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "first_frame",
                                    "first"
                                  ]
                                ]
                              }
                            }
                          },
                          "as": "media",
                          "in": {
                            "$ref": "media.url"
                          }
                        }
                      }
                    },
                    {
                      "$first": {
                        "$map": {
                          "from": {
                            "$sortByOrder": {
                              "$ref": "request.images"
                            }
                          },
                          "as": "media",
                          "in": {
                            "$ref": "media.url"
                          }
                        }
                      }
                    }
                  ]
                },
                "else": null
              }
            },
            "end_frame_url": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                        },
                        {
                          "$if": {
                            "condition": {
                              "$gt": [
                                {
                                  "$add": [
                                    {
                                      "$len": {
                                        "$sortByOrder": {
                                          "$ref": "request.videos"
                                        }
                                      }
                                    },
                                    {
                                      "$len": {
                                        "$sortByOrder": {
                                          "$ref": "request.audios"
                                        }
                                      }
                                    },
                                    {
                                      "$len": {
                                        "$filter": {
                                          "from": {
                                            "$sortByOrder": {
                                              "$ref": "request.images"
                                            }
                                          },
                                          "as": "media",
                                          "where": {
                                            "$eq": [
                                              {
                                                "$ref": "media.role"
                                              },
                                              "reference_image"
                                            ]
                                          }
                                        }
                                      }
                                    }
                                  ]
                                },
                                0
                              ]
                            },
                            "then": "omni_reference",
                            "else": "first_last_frames"
                          }
                        }
                      ]
                    },
                    "first_last_frames"
                  ]
                },
                "then": {
                  "$coalesce": [
                    {
                      "$first": {
                        "$map": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "last_frame",
                                    "end_frame",
                                    "last",
                                    "tail"
                                  ]
                                ]
                              }
                            }
                          },
                          "as": "media",
                          "in": {
                            "$ref": "media.url"
                          }
                        }
                      }
                    },
                    {
                      "$if": {
                        "condition": {
                          "$eq": [
                            {
                              "$len": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              }
                            },
                            2
                          ]
                        },
                        "then": {
                          "$last": {
                            "$map": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "in": {
                                "$ref": "media.url"
                              }
                            }
                          }
                        },
                        "else": null
                      }
                    }
                  ]
                },
                "else": null
              }
            },
            "multi_frames": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                        },
                        {
                          "$if": {
                            "condition": {
                              "$gt": [
                                {
                                  "$add": [
                                    {
                                      "$len": {
                                        "$sortByOrder": {
                                          "$ref": "request.videos"
                                        }
                                      }
                                    },
                                    {
                                      "$len": {
                                        "$sortByOrder": {
                                          "$ref": "request.audios"
                                        }
                                      }
                                    },
                                    {
                                      "$len": {
                                        "$filter": {
                                          "from": {
                                            "$sortByOrder": {
                                              "$ref": "request.images"
                                            }
                                          },
                                          "as": "media",
                                          "where": {
                                            "$eq": [
                                              {
                                                "$ref": "media.role"
                                              },
                                              "reference_image"
                                            ]
                                          }
                                        }
                                      }
                                    }
                                  ]
                                },
                                0
                              ]
                            },
                            "then": "omni_reference",
                            "else": "first_last_frames"
                          }
                        }
                      ]
                    },
                    "multi_frame"
                  ]
                },
                "then": {
                  "$map": {
                    "from": {
                      "$sortByOrder": {
                        "$ref": "request.images"
                      }
                    },
                    "as": "media",
                    "in": {
                      "$ref": "media.url"
                    }
                  }
                },
                "else": null
              }
            },
            "materials": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.minimaxh3-video.function_mode"
                        },
                        {
                          "$if": {
                            "condition": {
                              "$gt": [
                                {
                                  "$add": [
                                    {
                                      "$len": {
                                        "$sortByOrder": {
                                          "$ref": "request.videos"
                                        }
                                      }
                                    },
                                    {
                                      "$len": {
                                        "$sortByOrder": {
                                          "$ref": "request.audios"
                                        }
                                      }
                                    },
                                    {
                                      "$len": {
                                        "$filter": {
                                          "from": {
                                            "$sortByOrder": {
                                              "$ref": "request.images"
                                            }
                                          },
                                          "as": "media",
                                          "where": {
                                            "$eq": [
                                              {
                                                "$ref": "media.role"
                                              },
                                              "reference_image"
                                            ]
                                          }
                                        }
                                      }
                                    }
                                  ]
                                },
                                0
                              ]
                            },
                            "then": "omni_reference",
                            "else": "first_last_frames"
                          }
                        }
                      ]
                    },
                    "omni_reference"
                  ]
                },
                "then": {
                  "$concatArrays": [
                    {
                      "$map": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "in": {
                          "type": "image",
                          "url": {
                            "$ref": "media.url"
                          },
                          "name": {
                            "$coalesce": [
                              {
                                "$trim": {
                                  "$ref": "media.name"
                                }
                              },
                              {
                                "$concat": [
                                  "image_file_",
                                  {
                                    "$add": [
                                      {
                                        "$ref": "mediaIndex"
                                      },
                                      1
                                    ]
                                  }
                                ]
                              }
                            ]
                          }
                        }
                      }
                    },
                    {
                      "$map": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.videos"
                          }
                        },
                        "as": "media",
                        "in": {
                          "type": "video",
                          "url": {
                            "$ref": "media.url"
                          },
                          "name": {
                            "$coalesce": [
                              {
                                "$trim": {
                                  "$ref": "media.name"
                                }
                              },
                              {
                                "$concat": [
                                  "video_file_",
                                  {
                                    "$add": [
                                      {
                                        "$ref": "mediaIndex"
                                      },
                                      1
                                    ]
                                  }
                                ]
                              }
                            ]
                          }
                        }
                      }
                    },
                    {
                      "$map": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.audios"
                          }
                        },
                        "as": "media",
                        "in": {
                          "type": "audio",
                          "url": {
                            "$ref": "media.url"
                          },
                          "name": {
                            "$coalesce": [
                              {
                                "$trim": {
                                  "$ref": "media.name"
                                }
                              },
                              {
                                "$concat": [
                                  "audio_file_",
                                  {
                                    "$add": [
                                      {
                                        "$ref": "mediaIndex"
                                      },
                                      1
                                    ]
                                  }
                                ]
                              }
                            ]
                          }
                        }
                      }
                    }
                  ]
                },
                "else": null
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/tasks/{{taskId}}"
        },
        "result": {
          "method": "GET",
          "path": "/v1/tasks/{{taskId}}/download",
          "query": {
            "index": 0
          }
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$switch": {
              "cases": [
                {
                  "when": {
                    "$in": [
                      {
                        "$ref": "response.status"
                      },
                      [
                        "generating",
                        "post_processing",
                        "finalizing"
                      ]
                    ]
                  },
                  "then": "processing"
                }
              ],
              "default": {
                "$coalesce": [
                  {
                    "$ref": "response.status"
                  },
                  "pending"
                ]
              }
            }
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.fail_reason"
              },
              {
                "$ref": "response.error"
              },
              {
                "$ref": "response.progress_text"
              }
            ]
          },
          "errorPaths": [
            "error"
          ],
          "resultEphemeral": true
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
