<script setup lang="ts">
import { useWidget } from '../../../../src/index'

const { t } = useWidget()
</script>

<template>
  <p class="fixture">{{ t({ de: 'Fixture-Widget', en: 'Fixture widget' }) }}</p>
</template>

<style>
.fixture {
  color: var(--ui-text);
}
</style>
