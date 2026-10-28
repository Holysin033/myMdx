import { ref, computed, watchEffect } from 'vue'

export type ThemeMode = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'mymdx:theme'
const MODES: ThemeMode[] = ['auto', 'light', 'dark']

function stored(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY)
  return MODES.includes(v as ThemeMode) ? (v as ThemeMode) : 'auto'
}

// 模块级单例：主题是全局的，不需要每处调用都新建一份状态
const mode = ref<ThemeMode>(stored())
const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)
const mql = window.matchMedia('(prefers-color-scheme: dark)')
const onSystemChange = (e: MediaQueryListEvent) => (systemDark.value = e.matches)
mql.addEventListener('change', onSystemChange)

const isDark = computed(
  () => mode.value === 'dark' || (mode.value === 'auto' && systemDark.value),
)

watchEffect(() => {
  document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light'
  localStorage.setItem(STORAGE_KEY, mode.value)
})

export function useTheme() {
  return {
    mode,
    isDark,
    /** auto → light → dark → auto */
    cycle() {
      mode.value = MODES[(MODES.indexOf(mode.value) + 1) % MODES.length]!
    },
    label: computed(() =>
      mode.value === 'auto' ? '跟随系统' : mode.value === 'dark' ? '暗色' : '亮色',
    ),
  }
}
