
function mapOrderToAutomationInput(order) {
  if (
    !order ||
    typeof order !== 'object' ||
    Array.isArray(order)
  ) {
    throw new Error('Order body must be a JSON object.');
  }

  const requiredSections = [
    'customer',
    'accountHolder',
    'plan',
    'checkout',
    'installation',
    'execution'
  ];

  for (const section of requiredSections) {
    if (
      !order[section] ||
      typeof order[section] !== 'object' ||
      Array.isArray(order[section])
    ) {
      throw new Error(`Missing or invalid order section: ${section}`);
    }
  }

  // Keep the API restricted to the demo workflow.
  if (
    order.execution.mode !== 'demo' ||
    order.execution.stopBeforeFinalOrderSubmission !== true
  ) {
    throw new Error(
      'Only demo orders with final submission disabled are accepted.'
    );
  }

  // Do not accept identity or payment data through this API.
  if (
    Object.prototype.hasOwnProperty.call(order, 'identity') ||
    Object.prototype.hasOwnProperty.call(order, 'payment')
  ) {
    throw new Error(
      'Identity and payment sections are not accepted by this API.'
    );
  }

  if (order.installation.confirmInstallation === true) {
    throw new Error(
      'Installation confirmation cannot be enabled through this API.'
    );
  }

  const customer = order.customer;
  const accountHolder = order.accountHolder;
  const plan = order.plan;
  const checkout = order.checkout;
  const installation = order.installation;

  return {
    customer: {
      prefix: customer.prefix || 'Mr',
      firstName: customer.firstName,
      middleInitial: customer.middleInitial || '',
      lastName: customer.lastName,
      address: customer.streetAddress,
      unitNumber: customer.unitNumber,
      city: customer.city,
      zipCode: customer.zipCode,
      unitType: customer.unitType,
      state: customer.state,
      serviceAddressType: customer.residenceType,
      rentOwn: customer.ownership,
      callId: customer.leadId || 'DEMO-001',
      customerMove: customer.moving,
      moveInDate: customer.moveInDate || ''
    },

    qualification: {
      customerType: String(order.customerType || '').toLowerCase()
    },

    plan: {
      provider: order.provider,
      speed: `${order.speedMbps} Mbps`,
      term: plan.term,
      monthlyPrice: plan.monthlyPrice,
      installationPrice: plan.installationPrice
    },

    checkout: {
      broadbandFactLabels:
        checkout.broadbandFactLabels || 'not_requested',
      broadbandFactLabelsRead:
        checkout.broadbandFactLabelsRead === true,
      equipment: checkout.equipment,
      nowTv: checkout.nowTv === true
    },

    accountHolder: {
      contact: {
        phone: customer.phone,
        email: customer.email
      },
      isAccountHolder: accountHolder.isAccountHolder,
      isExistingProviderCustomer:
        accountHolder.isExistingProviderCustomer,
      ezEnroll: accountHolder.ezEnroll,
      automaticPayments: accountHolder.automaticPayments,
      readAcknowledgement: accountHolder.readAcknowledgement,
      mailingAddressSameAsService:
        accountHolder.mailingAddressSameAsService,
      shippingAddressSameAsService:
        accountHolder.shippingAddressSameAsService
    },

    // These actions remain disabled in the demo workflow.
    identity: {
      ssn: '',
      dateOfBirth: ''
    },

    installation: {
      type: installation.type,
      confirmInstallation: false
    },

    payment: {
      method: 'none'
    },

    execution: {
      mode: 'demo',
      stopBeforeFinalOrderSubmission: true
    }
  };
}

module.exports = {
  mapOrderToAutomationInput
};
