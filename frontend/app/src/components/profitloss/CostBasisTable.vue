<template>
  <table-expand-container :visible="visible" :colspan="colspan" :padded="false">
    <template #title>
      {{ $t('cost_basis_table.cost_basis') }}
      <span class="text-caption">
        {{
          costBasis.isComplete
            ? $t('cost_basis_table.complete')
            : $t('cost_basis_table.incomplete')
        }}
      </span>
    </template>
    <data-table
      class="cost-basis-table__table"
      :items="costBasis.matchedAcquisitions"
      :headers="headers"
      item-key="id"
      sort-by="time"
    >
      <template #item.location="{ item }">
        <location-display :identifier="item.location" />
      </template>
      <template #item.usedAmount="{ item }">
        <amount-display :value="item.usedAmount" />
      </template>
      <template #item.amount="{ item }">
        <amount-display :value="item.amount" />
      </template>
      <template #item.fee="{ item }">
        <amount-display :value="item.fee" />
      </template>
      <template #item.feeRate="{ item }">
        <amount-display :value="item.feeRate" />
      </template>
      <template #item.time="{ item }">
        <date-display :timestamp="item.time" />
      </template>
    </data-table>
  </table-expand-container>
</template>

<script lang="ts">
import { Component, Prop, Vue } from 'vue-property-decorator';
import { DataTableHeader } from 'vuetify';
import DataTable from '@/components/helper/DataTable.vue';
import Fragment from '@/components/helper/Fragment';
import { CostBasis } from '@/store/reports/types';

@Component({
  components: { DataTable, Fragment }
})
export default class CostBasisTable extends Vue {
  readonly headers: DataTableHeader[] = [
    {
      text: this.$t('cost_basis_table.headers.location').toString(),
      value: 'location',
      width: '120px',
      align: 'center'
    },
    {
      text: this.$t('cost_basis_table.headers.description').toString(),
      value: 'description'
    },
    {
      text: this.$t('cost_basis_table.headers.used_amount').toString(),
      value: 'usedAmount',
      align: 'end'
    },
    {
      text: this.$t('cost_basis_table.headers.amount').toString(),
      value: 'amount',
      align: 'end'
    },
    {
      text: this.$t('cost_basis_table.headers.rate').toString(),
      value: 'rate',
      align: 'end'
    },
    {
      text: this.$t('cost_basis_table.headers.fee_rate').toString(),
      value: 'feeRate',
      align: 'end'
    },
    {
      text: this.$t('cost_basis_table.headers.time').toString(),
      value: 'time'
    }
  ];
  @Prop({ required: true, type: Object })
  costBasis!: CostBasis;
  @Prop({ required: true, type: Boolean })
  visible!: boolean;
  @Prop({ required: true, type: Number })
  colspan!: number;
}
</script>

<style scoped lang="scss">
::v-deep {
  th {
    &:first-child {
      span {
        padding-left: 16px;
      }
    }
  }
}
</style>
