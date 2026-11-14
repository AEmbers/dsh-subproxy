/**
 * `dsh-subproxy` — the browser half.
 *
 * A settings page with one card per route: sign in, paste the redirect a browser
 * on another device ended on, sign out, and see what the account actually
 * unlocked. Without it, signing in on a phone means typing
 * `/subproxy login sub-gemini` into the composer, which is the whole reason this
 * file exists.
 *
 * Three deliberate choices, each one paid for elsewhere:
 *
 * 1. **No build step.** This is hand-written ES5-ish JavaScript run through a
 *    plain IIFE. The plugin has to install on a proot Ubuntu phone with no
 *    compiler and no bundler, so there is no TSX source for this file to be
 *    generated from.
 * 2. **No `dsh.client.inject`.** The page touches only `slots` (to register
 *    itself) and `styles` (to insert CSS), both optional: asking for a service
 *    the phone profile does not provide leaves the whole section unmounted, and
 *    a settings page that silently never appears is worse than one drawn with
 *    inline styles.
 * 3. **Plain `fetch` to the plugin's own endpoint.** The host exposes no RPC for
 *    any of this, so there is nothing to call through `connection.rpc`.
 *
 * @module dsh-subproxy/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-subproxy',
  factory: function (require) {
    var module = { exports: {} }
    var __esRequire = require

    ;(function () {
      'use strict'

      var ENDPOINT = '/plugins/dsh-subproxy'
      var SECTION_ID = 'subproxy'
      var ORDER = 460

      /**
       * Resolve the React runtime.
       *
       * `react` is a PLATFORM_MODULES seed, so the factory's own `require` is the
       * documented way in; `window.React` is what a differently-built shell may
       * leave behind, and the DOM-fiber walk is the last resort.
       *
       * @returns {{ React: object, source: string } | null} the runtime.
       */
      function resolveReact() {
        try {
          if (typeof __esRequire === 'function') {
            var mod = __esRequire('react')
            var candidate = mod && mod.default && mod.default.createElement ? mod.default : mod
            if (candidate && typeof candidate.createElement === 'function') {
              return { React: candidate, source: "require('react')" }
            }
          }
        } catch (error) {
          console.warn('[subproxy] require("react") 失败：' + String(error))
        }
        var win = typeof window !== 'undefined' ? window : null
        if (win && win.React && typeof win.React.createElement === 'function') {
          return { React: win.React, source: 'window.React' }
        }
        return null
      }

      /* ── styles ─────────────────────────────────────────────────────────── */

      var CSS = [
        '.spx-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}',
        '.spx-card{border:1px solid rgba(128,128,128,.28);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}',
        '.spx-card[data-state="pending"]{border-color:rgba(240,170,60,.6)}',
        '.spx-card[data-state="on"]{border-color:rgba(80,180,120,.55)}',
        '.spx-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.spx-name{font-weight:600;font-size:13.5px}',
        '.spx-route{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;opacity:.55}',
        '.spx-pill{margin-left:auto;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid rgba(128,128,128,.4);white-space:nowrap}',
        '.spx-pill[data-tone="on"]{border-color:rgba(80,180,120,.7);color:rgba(70,175,115,1)}',
        '.spx-pill[data-tone="pending"]{border-color:rgba(240,170,60,.8);color:rgba(225,155,45,1)}',
        '.spx-pill[data-tone="off"]{opacity:.65}',
        '.spx-meta{display:flex;gap:6px 14px;flex-wrap:wrap;opacity:.78;font-size:12px}',
        '.spx-meta b{font-weight:600;opacity:1}',
        '.spx-warn{font-size:12px;color:rgba(225,155,45,1)}',
        '.spx-actions{display:flex;gap:8px;flex-wrap:wrap}',
        '.spx-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:7px;cursor:pointer;',
        'border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit}',
        '.spx-btn:disabled{opacity:.45;cursor:default}',
        '.spx-btn[data-primary="1"]{border-color:transparent;background:rgba(90,130,255,.9);color:#fff}',
        '.spx-btn[data-danger="1"]{color:rgba(225,105,95,1);border-color:rgba(225,105,95,.5)}',
        '.spx-notices{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:8px;',
        'background:rgba(128,128,128,.09)}',
        '.spx-url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;',
        'word-break:break-all;color:rgba(90,130,255,1)}',
        '.spx-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px;',
        'letter-spacing:2px;font-weight:600}',
        '.spx-paste{display:flex;gap:6px}',
        '.spx-paste input{flex:1;min-width:0;font:inherit;font-size:12px;padding:4px 8px;border-radius:7px;',
        'border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit}',
        '.spx-msg{font-size:12px;white-space:pre-wrap}',
        '.spx-msg[data-tone="error"]{color:rgba(225,105,95,1)}',
        '.spx-msg[data-tone="ok"]{color:rgba(70,175,115,1)}',
        '.spx-empty{opacity:.6;font-size:12px}',
      ].join('')

      function insertStyles(ctx) {
        try {
          var styles = ctx.get && ctx.get('styles')
          if (styles && typeof styles.insert === 'function') {
            ctx.effect(function () {
              return styles.insert(CSS)
            }, 'subproxy: styles')
            return
          }
        } catch (error) {
          // Fall through to the DOM path.
        }
        try {
          var node = document.createElement('style')
          node.dataset.plugin = 'dsh-subproxy'
          node.textContent = CSS
          document.head.append(node)
          ctx.effect(function () {
            return function () {
              node.remove()
            }
          }, 'subproxy: styles')
        } catch (error) {
          // No document: the page is not mounted, and nothing renders anyway.
        }
      }

      /* ── the endpoint ───────────────────────────────────────────────────── */

      /**
       * Call the plugin's own endpoint.
       *
       * A failure is reported as data, never thrown: a settings page that throws
       * during render takes the whole panel down with it.
       *
       * @param {string} method - `GET` or `POST`.
       * @param {object} [body] - the JSON payload for a POST.
       * @returns {Promise<object>} the parsed reply, or `{ ok: false, error }`.
       */
      function call(method, body) {
        var init = { method: method, headers: { Accept: 'application/json' } }
        if (body !== undefined) {
          init.headers['Content-Type'] = 'application/json'
          init.body = JSON.stringify(body)
        }
        return fetch(ENDPOINT, init).then(
          function (response) {
            return response
              .json()
              .catch(function () {
                return {}
              })
              .then(function (payload) {
                if (!response.ok && payload.error === undefined) {
                  payload.error = '宿主返回 ' + String(response.status) + '。'
                }
                return payload
              })
          },
          function (error) {
            return { ok: false, error: '连不上宿主：' + String(error) }
          },
        )
      }

      /* ── the page ───────────────────────────────────────────────────────── */

      var React = null
      var h = null

      /**
       * Build the settings card component.
       *
       * Defined inside `apply` so it closes over the React instance resolved
       * there; the slot system may call it at any later time.
       *
       * @returns {Function} the component.
       */
      function makeCard() {
        return function SubproxySettings() {
          var useState = React.useState
          var useEffect = React.useEffect
          var useCallback = React.useCallback

          var state = useState({ routes: [], pending: [] })
          var busyState = useState('')
          var messageState = useState(null)
          var pastedState = useState('')

          var data = state[0]
          var setData = state[1]
          var busy = busyState[0]
          var setBusy = busyState[1]
          var message = messageState[0]
          var setMessage = messageState[1]
          var pasted = pastedState[0]
          var setPasted = pastedState[1]

          var refresh = useCallback(function () {
            return call('GET').then(function (payload) {
              if (payload.routes !== undefined) {
                setData({ routes: payload.routes, pending: payload.pending ?? [] })
              }
              return payload
            })
          }, [])

          useEffect(function () {
            void refresh()
          }, [refresh])

          // A flow in flight ends on the identity provider's schedule, and the
          // page has no event to wait on, so it polls — but only while there is
          // something to poll for. An idle settings page must not cost requests.
          useEffect(
            function () {
              if (data.pending.length === 0) return undefined
              var timer = setInterval(function () {
                void refresh()
              }, 2500)
              return function () {
                clearInterval(timer)
              }
            },
            [data.pending.length, refresh],
          )

          var act = useCallback(
            function (label, payload) {
              setBusy(label)
              setMessage(null)
              return call('POST', payload).then(function (reply) {
                if (reply.routes !== undefined) {
                  setData({ routes: reply.routes, pending: reply.pending ?? [] })
                }
                if (reply.text !== undefined) {
                  setMessage({ tone: reply.ok ? 'ok' : 'error', text: reply.text })
                } else if (reply.error !== undefined) {
                  setMessage({ tone: 'error', text: reply.error })
                }
                setBusy('')
                return reply
              })
            },
            [],
          )

          var children = data.routes.map(function (row) {
            var entry = null
            for (var i = 0; i < data.pending.length; i += 1) {
              if (data.pending[i].route === row.route) entry = data.pending[i]
            }
            var badge =
              entry !== null ? { tone: 'pending', text: '待授权' } : row.signedIn ? { tone: 'on', text: '已登录' } : { tone: 'off', text: '未登录' }

            var meta = []
            if (row.signedIn) {
              meta.push(h('span', { key: 'id' }, ['账号 ', h('b', { key: 'v' }, row.identity || '未知')]))
              if (row.plan) meta.push(h('span', { key: 'plan' }, ['套餐 ', h('b', { key: 'v' }, row.plan)]))
              if (row.expired && row.refreshable) {
                meta.push(h('span', { key: 'exp' }, '访问令牌已过期，下次使用自动刷新'))
              }
            }
            if (row.models > 0) {
              meta.push(
                h('span', { key: 'models' }, ['可用模型 ', h('b', { key: 'v' }, String(row.models))]),
              )
            }
            if (row.hidden > 0) {
              meta.push(h('span', { key: 'hidden' }, ['另有 ', h('b', { key: 'v' }, String(row.hidden)), ' 个需升级套餐']))
            }

            var actions = []
            if (entry === null) {
              actions.push(
                h(
                  'button',
                  {
                    key: 'login',
                    type: 'button',
                    className: 'spx-btn',
                    'data-primary': '1',
                    disabled: busy !== '',
                    onClick: function () {
                      void act('login:' + row.route, { action: 'login', route: row.route })
                    },
                  },
                  busy === 'login:' + row.route ? '正在获取授权地址…' : '登录',
                ),
              )
              if (row.supportsDeviceCode === true) {
                actions.push(
                  h(
                    'button',
                    {
                      key: 'device',
                      type: 'button',
                      className: 'spx-btn',
                      disabled: busy !== '',
                      onClick: function () {
                        void act('device:' + row.route, { action: 'login', route: row.route, method: 'device' })
                      },
                    },
                    '设备码登录',
                  ),
                )
              }
              if (row.signedIn) {
                actions.push(
                  h(
                    'button',
                    {
                      key: 'out',
                      type: 'button',
                      className: 'spx-btn',
                      'data-danger': '1',
                      disabled: busy !== '',
                      onClick: function () {
                        var target = row.route
                        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                          if (!window.confirm('退出后 ' + row.name + ' 的凭据会被删除，确定吗？')) return
                        }
                        void act('logout:' + target, { action: 'logout', route: target })
                      },
                    },
                    '退出登录',
                  ),
                )
              }
            } else {
              actions.push(
                h(
                  'button',
                  {
                    key: 'cancel',
                    type: 'button',
                    className: 'spx-btn',
                    disabled: busy !== '',
                    onClick: function () {
                      void act('logout:' + row.route, { action: 'logout', route: row.route })
                    },
                  },
                  '取消这次登录',
                ),
              )
            }

            var notices = []
            if (entry !== null) {
              var deviceFlow = false
              for (var n = 0; n < entry.notices.length; n += 1) {
                var notice = entry.notices[n]
                if (notice.kind === 'device_code') deviceFlow = true
                var bits = []
                if (notice.message) {
                  bits.push(h('div', { key: 'm', className: 'spx-msg' }, notice.message))
                }
                if (notice.url) {
                  bits.push(
                    h(
                      'a',
                      {
                        key: 'u',
                        className: 'spx-url',
                        href: notice.url,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                      },
                      notice.url,
                    ),
                  )
                }
                if (notice.code) {
                  bits.push(h('div', { key: 'c', className: 'spx-code' }, notice.code))
                }
                notices.push(h('div', { key: 'n' + String(n) }, bits))
              }
              notices.push(
                h(
                  'div',
                  { key: 'body', className: 'spx-msg' },
                  deviceFlow
                    ? '在任意设备的浏览器里输入上面的代码即可，这边不用粘贴任何东西；完成后点一下刷新状态。'
                    : '浏览器不在这台机器上时，跳转到的 localhost 地址打不开，把地址栏那一整串粘到下面。',
                ),
              )
              if (entry.awaitingCode === true) {
                notices.push(
                  h('div', { key: 'paste', className: 'spx-paste' }, [
                    h('input', {
                      key: 'in',
                      type: 'text',
                      value: pasted,
                      placeholder: '粘贴跳转后的完整地址或 code',
                      onChange: function (event) {
                        setPasted(event.target.value)
                      },
                    }),
                    h(
                      'button',
                      {
                        key: 'go',
                        type: 'button',
                        className: 'spx-btn',
                        'data-primary': '1',
                        disabled: busy !== '' || pasted.trim() === '',
                        onClick: function () {
                          var value = pasted.trim()
                          if (value === '') return
                          setPasted('')
                          void act('code:' + row.route, { action: 'code', route: row.route, value: value })
                        },
                      },
                      '提交',
                    ),
                  ]),
                )
              }
              notices.push(
                h(
                  'div',
                  { key: 'again', className: 'spx-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'spx-btn',
                      disabled: busy !== '',
                      onClick: function () {
                        void act('refresh:' + row.route, { action: 'status' })
                      },
                    },
                    '刷新状态',
                  ),
                ),
              )
            }

            return h(
              'div',
              {
                key: row.route,
                className: 'spx-card',
                'data-state': entry !== null ? 'pending' : row.signedIn ? 'on' : 'off',
              },
              [
                h('div', { key: 'head', className: 'spx-head' }, [
                  h('span', { key: 'n', className: 'spx-name' }, row.name),
                  h('span', { key: 'r', className: 'spx-route' }, row.route),
                  h('span', { key: 'p', className: 'spx-pill', 'data-tone': badge.tone }, badge.text),
                ]),
                meta.length > 0 ? h('div', { key: 'meta', className: 'spx-meta' }, meta) : null,
                row.fallback === true
                  ? h(
                      'div',
                      { key: 'fallback', className: 'spx-warn' },
                      '当前显示的是内置兜底列表，说明还没有读到这个账号的真实目录；登录后如仍未恢复，点「刷新状态」重试。',
                    )
                  : null,
                h('div', { key: 'act', className: 'spx-actions' }, actions),
                notices.length > 0 ? h('div', { key: 'nt', className: 'spx-notices' }, notices) : null,
              ],
            )
          })

          return h('div', { className: 'spx-wrap' }, [
            h(
              'div',
              { key: 'intro', className: 'spx-msg' },
              '三个订阅上游各占一条路由。登录靠订阅账号本身，不消耗 API 额度；Antigravity 会按账号套餐列出可用模型，档位不足的模型自动隐藏。',
            ),
            children.length > 0 ? children : h('div', { key: 'empty', className: 'spx-empty' }, '正在读取路由…'),
            message !== null
              ? h('div', { key: 'msg', className: 'spx-msg', 'data-tone': message.tone }, message.text)
              : null,
            h(
              'div',
              { key: 'foot', className: 'spx-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'spx-btn',
                  disabled: busy !== '',
                  onClick: function () {
                    void act('refresh', { action: 'status' })
                  },
                },
                '刷新',
              ),
            ),
          ])
        }
      }

      /* ── the plugin ─────────────────────────────────────────────────────── */

      function apply(ctx) {
        var found = resolveReact()
        if (found === null) {
          console.warn('[subproxy] 拿不到 React 运行时，设置页不会挂载（命令 /subproxy 仍可用）')
          return
        }
        React = found.React
        h = React.createElement

        insertStyles(ctx)

        var Card = makeCard()
        try {
          // `inject` first, `register` second: the shell owns the declaration for
          // this slot name, and registering before it is declared is dropped
          // without a word.
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: ORDER,
                label: function () {
                  return '订阅反代'
                },
              },
              Card,
            )
          })
        } catch (error) {
          console.error('[subproxy] 注册设置页失败：' + String(error))
        }
      }

      module.exports = { apply: apply, inject: ['slots'], name: 'subproxy' }
    })()

    if (module.exports && typeof module.exports.apply === 'function') return module.exports
    throw new Error('dsh-subproxy: 客户端 bundle 未设置导出')
  },
})
