# 老李媒体 API 接口映射

## 系统渠道

本包在系统渠道协议目录中注册四个彼此独立的 provider：

| Provider ID | 能力 | 默认接口地址 | 鉴权 |
| --- | --- | --- | --- |
| `laoli-image-openai` | OpenAI 同步图片生成和图片编辑 | `https://video.laoliimage2.win` | `Authorization: Bearer <API Key>` |
| `laoli-image-openai-async` | OpenAI 异步图片生成和任务查询 | `https://video.laoliimage2.win` | `Authorization: Bearer <API Key>` |
| `laoli-image-gemini` | Gemini 原生图片生成 | `https://video.laoliimage2.win` | `x-goog-api-key: <API Key>` |
| `laoli-video` | 异步视频生成、状态查询和内容读取 | `https://video.laoliimage2.win` | `Authorization: Bearer <API Key>` |

四个协议都使用系统渠道的 API Key；按实际 API Key 绑定的账户和模型权限计费。修改系统渠道根地址时应填写主机根 URL，不追加具体 API 路径。

## OpenAI 图片

同步生成：`POST /v1/images/generations`。有输入参考图时改为 `POST /v1/images/edits`，以 multipart 上传按顺序重复的 `image` 字段；宿主会读取参考媒体并生成 multipart 文件。插件把 `model`、`prompt`、`n`、`size`、`resolution` 和 `response_format` 映射到上游。工作台 `count` 参数绑定到 `n`，默认 1；`size` 尺寸参数绑定到 OpenAI `size`，`imageResolution` 分辨率档位绑定并大写后写入 `resolution`。`response_format` 可选 `url` 或 `b64_json`，默认 `url`。不设置 `stream`。

异步生成使用独立 provider `laoli-image-openai-async`，提交 `POST /v1/images/generations/async`，状态查询为 `GET /v1/images/tasks/{id}`。异步 provider 支持文档定义的 JSON 生图字段，不声明编辑输入。`count` 绑定到 `n`（默认 1），`size` 绑定到尺寸，`imageResolution` 绑定到分辨率档位。创建和查询响应映射 OpenAI 风格的 `id`、`status`、`data[].url` / `data[].b64_json`。上游返回的签名图片 URL 由后端立即读取并保存为工作台资源；内联 Base64 也会转换成资源。

图片蒙版编辑从工作台的 `mask` 媒体角色单独映射到 multipart `mask` 文件，并从重复的 `image` 字段排除。最多允许一个蒙版；提交蒙版时至少同时提供一张编辑源图。

## Gemini 原生图片

请求为 `POST /v1beta/models/{model}:generateContent`。提示词和图片参考位于 `contents[0].parts`；data URL 图片映射成 `inlineData`，远程 Gemini 文件 URI 映射成 `fileData`。工作台 `size` 参数绑定到 `generationConfig.imageConfig.aspectRatio`；`imageResolution` 绑定到 `imageSize` 并转成大写（`1K`/`2K`/`4K`）。响应从 `candidates[0].content.parts[].inlineData` 或 `inline_data` 提取 MIME 类型与 Base64。

该协议用于 Gemini 原生生成，不复用 OpenAI 图片编辑或异步任务端点。

## 异步视频

创建 `POST /v1/videos` 使用 JSON：

| 上游字段 | 工作台字段 |
| --- | --- |
| `model` | 上游模型 ID（包括文档中的中文名称） |
| `prompt` | 原始视频提示词，不自动插入、改写或排序 `@图片N` 等文字 |
| `seconds` | `duration`，整数秒 |
| `resolution` | `resolution` |
| `aspect_ratio` | `aspectRatio` |
| `reference_images[]` | 图片引用 URL（保留顺序） |
| `reference_videos[]` | 视频引用 URL（保留顺序） |
| `reference_audios[]` | 音频引用 URL（保留顺序） |
| `enable_audio` | 只对 wan3.0-prime 型号映射 `generateAudio` |
| `Idempotency-Key` | 宿主为本次提交生成的唯一键 |

参考视频/音频必须是上游可公开读取的 HTTP(S) URL；JSON Base64 输入会在创建前拒绝。状态通过 `GET /v1/videos/{id}` 读取，`queued` 和 `in_progress` 保持待处理，`completed` 成功，`failed` 返回上游原因。成功时优先消费响应的 `url` / `video_url` 签名链接；没有直链时通过带鉴权的 `GET /v1/videos/{id}/content` 取结果。工作台会立即下载并持久化视频，不把约 72 小时的上游保留期限当作长期存储。

虽然提交携带幂等键，本插件不声明可自动安全重试；超时或结果未知时按宿主原任务恢复规则处理，不再次提交新生成。附件提到的 `/v1/video-submissions/current` 找回接口没有定义其参数和响应合同，故本包不调用它。

## 能力边界

- 图片同步/异步、Gemini 原生图片和视频任务各自选择对应 provider；不能把模型配置到错误能力的 provider。
- 视频端点按文档的 JSON 请求映射实现。文档只给出部分型号的时长、清晰度、素材数量限制，具体限制由上游按模型校验；插件不使用默认值伪装这些条件。
- 文档提到的特殊首尾帧能力未给出独立字段合同；此版本只发送文档明确的 `reference_images` 数组，不伪造首尾帧字段。
- 文档中 `GET /v1/media/tasks/{id}` 是视频查询别名，主查询使用明确列出的 `/v1/videos/{id}`。
- 签名 URL 本身是访问凭证。插件只把它用于服务端即时读取，不在日志或持久任务输入中主动复制该 URL。
- 不包含实时计费请求或 Key 验证。测试仅验证本地映射、任务状态和包结构。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "laoli-media-api",
  "name": "老李媒体 API",
  "version": "1.0.0",
  "author": "老李媒体 / 影策",
  "description": "老李媒体 OpenAI 图片、Gemini 图片和异步视频系统渠道协议。",
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
        "id": "laoli-image-openai",
        "label": "老李媒体 OpenAI 图片",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://video.laoliimage2.win",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "imageParameters": [
          {
            "name": "size",
            "label": "图片尺寸",
            "type": "string",
            "binding": "aspectRatio",
            "encoding": "pixels"
          },
          {
            "name": "imageResolution",
            "label": "分辨率档位",
            "type": "string",
            "binding": "resolution",
            "values": [
              "1k",
              "2k",
              "4k"
            ],
            "pricing": true
          },
          {
            "name": "count",
            "label": "生成数量",
            "type": "integer",
            "binding": "imageCount",
            "min": 1,
            "max": 1,
            "default": 1
          },
          {
            "name": "responseFormat",
            "label": "图片响应格式",
            "type": "string",
            "binding": "providerOptions.laoli-image-openai.response_format",
            "values": [
              "url",
              "b64_json"
            ],
            "default": "url"
          }
        ],
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "使用附件列出的 OpenAI 图片模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "multipart image[] or JSON edits input",
            "description": "参考图/编辑源图；蒙版使用 role=mask。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "n",
            "description": "输出图片数量；由工作台任务参数提供。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size",
            "description": "OpenAI 图片尺寸或像素尺寸。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution",
            "description": "1K、2K 或 4K 分辨率档位。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "providerOptions.laoli-image-openai",
            "description": "协议专属图片参数。"
          }
        ],
        "validations": [
          {
            "assert": {
              "$lte": [
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
                1
              ]
            },
            "message": "图片编辑最多接受一个 mask 文件。"
          },
          {
            "assert": {
              "$or": [
                {
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
                {
                  "$gt": [
                    {
                      "$len": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "where": {
                            "$ne": [
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
                }
              ]
            },
            "message": "图片 mask 必须和至少一张源 image 一起提交。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/images/generations",
          "pathTemplate": {
            "$if": {
              "condition": {
                "$gt": [
                  {
                    "$len": {
                      "$ref": "request.images"
                    }
                  },
                  0
                ]
              },
              "then": "/v1/images/edits",
              "else": "/v1/images/generations"
            }
          },
          "contentType": "application/json",
          "contentTypeTemplate": {
            "$if": {
              "condition": {
                "$gt": [
                  {
                    "$len": {
                      "$ref": "request.images"
                    }
                  },
                  0
                ]
              },
              "then": "multipart/form-data",
              "else": "application/json"
            }
          },
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "n": {
              "$coalesce": [
                {
                  "$if": {
                    "condition": {
                      "$gt": [
                        {
                          "$ref": "request.imageCount"
                        },
                        0
                      ]
                    },
                    "then": {
                      "$ref": "request.imageCount"
                    },
                    "else": null
                  }
                },
                1
              ]
            },
            "size": {
              "$omitEmpty": {
                "$ref": "request.aspectRatio"
              }
            },
            "resolution": {
              "$omitEmpty": {
                "$upper": {
                  "$ref": "request.resolution"
                }
              }
            },
            "response_format": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.laoli-image-openai.response_format"
                },
                "url"
              ]
            }
          },
          "files": [
            {
              "name": "image",
              "source": {
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
                        "$ne": [
                          {
                            "$ref": "media.role"
                          },
                          "mask"
                        ]
                      }
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              },
              "filename": "image.png"
            },
            {
              "name": "mask",
              "source": {
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
                          "$eq": [
                            {
                              "$ref": "media.role"
                            },
                            "mask"
                          ]
                        }
                      }
                    },
                    "as": "media",
                    "in": {
                      "$ref": "media.value"
                    }
                  }
                }
              },
              "filename": "mask.png",
              "mimeType": "image/png"
            }
          ]
        },
        "poll": {
          "method": "GET",
          "path": "/v1/images/tasks/{{taskId}}",
          "contentType": "application/json"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.taskId"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.data.status"
              },
              "succeeded"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.data.error.message"
              },
              {
                "$ref": "response.message"
              }
            ]
          },
          "images": {
            "$coalesce": [
              {
                "$map": {
                  "from": {
                    "$ref": "response.data"
                  },
                  "as": "item",
                  "in": {
                    "url": {
                      "$omitEmpty": {
                        "$ref": "item.url"
                      }
                    },
                    "dataUrl": {
                      "$if": {
                        "condition": {
                          "$ref": "item.b64_json"
                        },
                        "then": {
                          "$concat": [
                            "data:",
                            {
                              "$coalesce": [
                                {
                                  "$ref": "item.mime_type"
                                },
                                {
                                  "$ref": "item.mimeType"
                                },
                                "image/png"
                              ]
                            },
                            ";base64,",
                            {
                              "$ref": "item.b64_json"
                            }
                          ]
                        },
                        "else": null
                      }
                    }
                  }
                }
              },
              {
                "$ref": "response.data.url"
              },
              {
                "$ref": "response.data.b64_json"
              },
              {
                "$ref": "response.url"
              },
              {
                "$ref": "response.b64_json"
              }
            ]
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code",
            "data.error.code"
          ],
          "messagePaths": [
            "error.message",
            "data.error.message",
            "message"
          ],
          "resultEphemeral": true
        }
      },
      {
        "id": "laoli-image-openai-async",
        "label": "老李媒体 OpenAI 图片（异步）",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://video.laoliimage2.win",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "imageParameters": [
          {
            "name": "size",
            "label": "图片尺寸",
            "type": "string",
            "binding": "aspectRatio",
            "encoding": "pixels"
          },
          {
            "name": "imageResolution",
            "label": "分辨率档位",
            "type": "string",
            "binding": "resolution",
            "values": [
              "1k",
              "2k",
              "4k"
            ],
            "pricing": true
          },
          {
            "name": "count",
            "label": "生成数量",
            "type": "integer",
            "binding": "imageCount",
            "min": 1,
            "max": 1,
            "default": 1
          },
          {
            "name": "responseFormat",
            "label": "图片响应格式",
            "type": "string",
            "binding": "providerOptions.laoli-image-openai-async.response_format",
            "values": [
              "url",
              "b64_json"
            ],
            "default": "url"
          }
        ],
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "使用附件列出的 OpenAI 图片模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "none",
            "description": "附件没有定义异步图片编辑输入。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "n",
            "description": "输出图片数量；由工作台任务参数提供。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size",
            "description": "OpenAI 图片尺寸或像素尺寸。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution",
            "description": "1K、2K 或 4K 分辨率档位。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "providerOptions.laoli-image-openai-async",
            "description": "异步 OpenAI 图片专属参数。"
          }
        ],
        "validations": [
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$ref": "request.images"
                  }
                },
                0
              ]
            },
            "message": "老李媒体异步图片接口未定义编辑输入，请移除参考图或蒙版。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/images/generations/async",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "n": {
              "$coalesce": [
                {
                  "$if": {
                    "condition": {
                      "$gt": [
                        {
                          "$ref": "request.imageCount"
                        },
                        0
                      ]
                    },
                    "then": {
                      "$ref": "request.imageCount"
                    },
                    "else": null
                  }
                },
                1
              ]
            },
            "size": {
              "$omitEmpty": {
                "$ref": "request.aspectRatio"
              }
            },
            "resolution": {
              "$omitEmpty": {
                "$upper": {
                  "$ref": "request.resolution"
                }
              }
            },
            "response_format": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.laoli-image-openai-async.response_format"
                },
                "url"
              ]
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/images/tasks/{{taskId}}",
          "contentType": "application/json"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.taskId"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.data.status"
              },
              "queued"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.data.error.message"
              },
              {
                "$ref": "response.message"
              }
            ]
          },
          "images": {
            "$map": {
              "from": {
                "$ref": "response.data"
              },
              "as": "item",
              "in": {
                "url": {
                  "$omitEmpty": {
                    "$ref": "item.url"
                  }
                },
                "dataUrl": {
                  "$if": {
                    "condition": {
                      "$ref": "item.b64_json"
                    },
                    "then": {
                      "$concat": [
                        "data:",
                        {
                          "$coalesce": [
                            {
                              "$ref": "item.mime_type"
                            },
                            {
                              "$ref": "item.mimeType"
                            },
                            "image/png"
                          ]
                        },
                        ";base64,",
                        {
                          "$ref": "item.b64_json"
                        }
                      ]
                    },
                    "else": null
                  }
                }
              }
            }
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code",
            "data.error.code"
          ],
          "messagePaths": [
            "error.message",
            "data.error.message",
            "message"
          ],
          "resultEphemeral": true
        }
      },
      {
        "id": "laoli-image-gemini",
        "label": "老李媒体 Gemini 图片",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://video.laoliimage2.win",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "google-api-key",
          "field": "apiKey"
        },
        "imageParameters": [
          {
            "name": "size",
            "label": "画面比例",
            "type": "string",
            "binding": "aspectRatio",
            "encoding": "ratio",
            "values": [
              "1:1",
              "2:3",
              "3:2",
              "3:4",
              "4:3",
              "4:5",
              "5:4",
              "9:16",
              "16:9",
              "21:9"
            ]
          },
          {
            "name": "imageResolution",
            "label": "分辨率档位",
            "type": "string",
            "binding": "resolution",
            "values": [
              "1k",
              "2k",
              "4k"
            ],
            "pricing": true
          }
        ],
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "models/{model}",
            "description": "Gemini 图片模型 ID，例如 nano-banana-2。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "contents[0].parts[].text",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "contents[0].parts[].inlineData/fileData",
            "description": "可作为内联图片或 Gemini 文件 URI 发送的参考图。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "generationConfig.imageConfig.aspectRatio",
            "description": "Gemini 图片画面比例。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "generationConfig.imageConfig.imageSize",
            "description": "Gemini 图片分辨率档位。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1beta/models/{{model}}:generateContent",
          "contentType": "application/json",
          "body": {
            "contents": [
              {
                "role": "user",
                "parts": {
                  "$concatArrays": [
                    [
                      {
                        "text": {
                          "$ref": "request.prompt"
                        }
                      }
                    ],
                    {
                      "$map": {
                        "from": {
                          "$ref": "request.images"
                        },
                        "as": "media",
                        "in": {
                          "$if": {
                            "condition": {
                              "$ref": "media.dataUrl"
                            },
                            "then": {
                              "inlineData": {
                                "mimeType": {
                                  "$dataMime": {
                                    "$ref": "media.value"
                                  }
                                },
                                "data": {
                                  "$dataPayload": {
                                    "$ref": "media.value"
                                  }
                                }
                              }
                            },
                            "else": {
                              "fileData": {
                                "mimeType": {
                                  "$omitEmpty": {
                                    "$ref": "media.mimeType"
                                  }
                                },
                                "fileUri": {
                                  "$ref": "media.url"
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            ],
            "generationConfig": {
              "responseModalities": [
                "TEXT",
                "IMAGE"
              ],
              "imageConfig": {
                "aspectRatio": {
                  "$omitEmpty": {
                    "$ref": "request.aspectRatio"
                  }
                },
                "imageSize": {
                  "$omitEmpty": {
                    "$coalesce": [
                      {
                        "$upper": {
                          "$ref": "request.quality"
                        }
                      },
                      {
                        "$upper": {
                          "$ref": "request.resolution"
                        }
                      }
                    ]
                  }
                }
              }
            }
          }
        },
        "response": {
          "status": "succeeded",
          "images": {
            "$map": {
              "from": {
                "$filter": {
                  "from": {
                    "$ref": "response.candidates.0.content.parts"
                  },
                  "as": "part",
                  "where": {
                    "$or": [
                      {
                        "$ref": "part.inlineData"
                      },
                      {
                        "$ref": "part.inline_data"
                      }
                    ]
                  }
                }
              },
              "as": "part",
              "in": {
                "dataUrl": {
                  "$concat": [
                    "data:",
                    {
                      "$coalesce": [
                        {
                          "$ref": "part.inlineData.mimeType"
                        },
                        {
                          "$ref": "part.inline_data.mime_type"
                        },
                        "image/png"
                      ]
                    },
                    ";base64,",
                    {
                      "$coalesce": [
                        {
                          "$ref": "part.inlineData.data"
                        },
                        {
                          "$ref": "part.inline_data.data"
                        }
                      ]
                    }
                  ]
                }
              }
            }
          },
          "text": {
            "$map": {
              "from": {
                "$filter": {
                  "from": {
                    "$ref": "response.candidates.0.content.parts"
                  },
                  "as": "part",
                  "where": {
                    "$ref": "part.text"
                  }
                }
              },
              "as": "part",
              "in": {
                "$ref": "part.text"
              }
            }
          },
          "usage": {
            "$ref": "response.usageMetadata"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ]
        }
      },
      {
        "id": "laoli-video",
        "label": "老李媒体视频",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://video.laoliimage2.win",
        "requiresPublicMediaUrls": true,
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
            "description": "使用附件列出的中文页面名称或兼容的英文模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "原始视频提示词；插件不增删 @素材编号。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": true,
            "mapping": "seconds",
            "description": "视频时长，单位秒。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution",
            "description": "该模型支持的 480p、720p 或 1080p。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "aspect_ratio",
            "description": "模型支持时填写的画面比例。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "reference_images",
            "description": "按顺序发送的公网 HTTPS 图片 URL。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "reference_videos",
            "description": "按顺序发送的公网 HTTPS 视频 URL。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "reference_audios",
            "description": "按顺序发送的公网 HTTPS 音频 URL。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "required": false,
            "mapping": "enable_audio",
            "description": "成品视频声音开关；仅向 wan3.0-prime 模型传递。"
          },
          {
            "name": "idempotencyKey",
            "type": "string",
            "required": false,
            "mapping": "Idempotency-Key",
            "description": "宿主每次提交生成的唯一键；未知结果不自动重发。"
          }
        ],
        "validations": [
          {
            "assert": {
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
            "message": "视频提示词不能为空。"
          },
          {
            "assert": {
              "$gt": [
                {
                  "$ref": "request.duration"
                },
                0
              ]
            },
            "message": "seconds 必须是正整数秒数。"
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
                        "$ne": [
                          {
                            "$ref": "media.source.type"
                          },
                          "url"
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "老李媒体视频参考图必须是可公开读取的 URL。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.videos"
                      },
                      "as": "media",
                      "where": {
                        "$ne": [
                          {
                            "$ref": "media.source.type"
                          },
                          "url"
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "老李媒体视频参考视频必须是可公开读取的 URL。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.audios"
                      },
                      "as": "media",
                      "where": {
                        "$ne": [
                          {
                            "$ref": "media.source.type"
                          },
                          "url"
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "老李媒体视频参考音频必须是可公开读取的 URL。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/videos",
          "contentType": "application/json",
          "headers": {
            "Idempotency-Key": {
              "$ref": "request.extra.idempotencyKey"
            }
          },
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "seconds": {
              "$ref": "request.duration"
            },
            "resolution": {
              "$omitEmpty": {
                "$ref": "request.resolution"
              }
            },
            "aspect_ratio": {
              "$omitEmpty": {
                "$ref": "request.aspectRatio"
              }
            },
            "reference_images": {
              "$omitEmpty": {
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
            "reference_videos": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.videos"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.url"
                  }
                }
              }
            },
            "reference_audios": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.audios"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.url"
                  }
                }
              }
            },
            "enable_audio": {
              "$if": {
                "condition": {
                  "$in": [
                    {
                      "$lower": {
                        "$ref": "request.model"
                      }
                    },
                    [
                      "wan3.0-prime · 720p",
                      "wan3.0-prime · 1080p",
                      "wan3.0-prime · 1080p · 按条",
                      "wan3.0-prime-720p",
                      "wan3.0-prime-1080p",
                      "wan3.0-prime-1080p-按条"
                    ]
                  ]
                },
                "then": {
                  "$ref": "request.generateAudio"
                },
                "else": null
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/videos/{{taskId}}",
          "contentType": "application/json"
        },
        "result": {
          "method": "GET",
          "path": "/v1/videos/{{taskId}}/content",
          "headers": {
            "Accept": "video/mp4"
          }
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.taskId"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.data.status"
              },
              "queued"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.data.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.error"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.url"
              },
              {
                "$ref": "response.data.video_url"
              },
              {
                "$ref": "response.data.url"
              }
            ]
          },
          "errorPaths": [
            "error.code",
            "data.error.code",
            "code"
          ],
          "messagePaths": [
            "error.message",
            "data.error.message",
            "message"
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
