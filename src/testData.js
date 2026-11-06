
const dummyCustomer = {
  customer: {
    prefix: 'Mr',
    firstName: 'Alex',
    lastName: 'Morgan',
    address: '123 Example Street',
    unitNumber: '2',
    city: 'Albany',
    zipCode: '12207',
    unitType: 'Apartment',
    state: 'NY',
    serviceAddressType: 'Apartment',
    rentOwn: 'Rent',
    callId: 'TEST-001',
    customerMove: 'No'
  },

  qualification: {
    customerType: 'new'
  },

  plan: {
    provider: 'ProviderXX',
    speed: '300 Mbps',
    term: '1-year',
    monthlyPrice: 40,
    installationPrice: 0
  },

  checkout: {
    broadbandFactLabels: 'not_requested',
    broadbandFactLabelsRead: true,
    equipment: 'leased_gateway',
    nowTv: false
  },

  accountHolder: {
  isAccountHolder: true,
  isExistingProviderCustomer: false,
  ezEnroll: false,
  automaticPayments: false,
  readAcknowledgement: true,
  mailingAddressSameAsService: true,
  shippingAddressSameAsService: true,

  contact: {
    phone: '6369345333',
    email: 'josejero@gmail.com'
  }
},

  identity: {
    // Synthetic values for the demo portal only.
    ssn: '000000000',
    dateOfBirth: '01/01/1990'
  },

  installation: {
    preference: 'standard',
    confirmInstallation: false
  },

  payment: {
    // Do not use real payment details in this test.
    method: 'none'
  },

  execution: {
    mode: 'demo',
    stopBeforeFinalOrderSubmission: true
  }
};

module.exports = { dummyCustomer };
