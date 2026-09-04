<template>
  <t-dialog
    v-model:visible="visible"
    :header="title"
    :width="420"
    :confirm-btn="{
      content: busy ? loadingText : confirmText,
      theme: tone === 'danger' ? 'danger' : 'primary',
      loading: busy,
      disabled: busy,
    }"
    :cancel-btn="busy ? null : cancelText"
    :close-on-overlay-click="!busy"
    :on-close="onCancel"
    destroy-on-close
    @confirm="onConfirm">
    <slot>
      <p class="admin-modal-msg">{{ message }}</p>
    </slot>
  </t-dialog>
</template>

<script setup lang="ts">
import { MessagePlugin } from "tdesign-vue-next";

/**
 * 管理后台确认弹窗（2026-09-01 TDesign 化：t-dialog 薄封装）
 * 替代 window.confirm/alert。深色模式由布局在 <html> 上的
 * theme-mode 属性驱动（见 layouts/admin.vue），本组件自动跟随。
 *
 * 用法（父组件通过 ref 调用，API 与旧手搓版完全兼容）：
 *   const modal = ref<InstanceType<typeof AdminModal>>();
 *   modal.value?.open({
 *     title: "删除频道",
 *     message: "确定删除吗？",
 *     tone: "danger",
 *     confirmText: "删除",
 *     onConfirm: async () => { await doSomething(); },
 *   });
 * 确认 → 执行 onConfirm；成功自动关闭；失败保持打开（弹窗内显示错误）。
 */
const props = withDefaults(
  defineProps<{
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    tone?: "primary" | "danger";
  }>(),
  {
    title: "确认操作",
    message: "",
    confirmText: "确认",
    cancelText: "取消",
    tone: "primary",
  },
);

const visible = ref(false);
const busy = ref(false);
const errorMsg = ref("");
const loadingText = "处理中…";

// TDesign 的 confirm-btn 是对象字面量，title/文案随每次 open 更新走内部 ref
const title = ref(props.title);
const message = ref(props.message);
const confirmText = ref(props.confirmText);
const tone = ref<"primary" | "danger">(props.tone);

let onConfirmCb: (() => void | Promise<void>) | null = null;

function open(opts?: { title?: string; message?: string; confirmText?: string; tone?: "primary" | "danger"; onConfirm?: () => void | Promise<void> }) {
  if (opts?.title) title.value = opts.title;
  if (opts?.message) message.value = opts.message;
  if (opts?.confirmText) confirmText.value = opts.confirmText;
  if (opts?.tone) tone.value = opts.tone;
  onConfirmCb = opts?.onConfirm ?? null;
  busy.value = false;
  errorMsg.value = "";
  visible.value = true;
}

function close() {
  visible.value = false;
  onConfirmCb = null;
}

async function onConfirm() {
  busy.value = true;
  errorMsg.value = "";
  try {
    await onConfirmCb?.();
    close();
  } catch (e: any) {
    errorMsg.value = e?.message || "操作失败";
    MessagePlugin.error(errorMsg.value);
  } finally {
    busy.value = false;
  }
}

function onCancel() {
  if (busy.value) return;
  close();
}

defineExpose({ open, close });
</script>

<style scoped>
.admin-modal-msg {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-secondary, #4b5563);
  white-space: pre-line;
  word-break: break-all;
}
</style>
