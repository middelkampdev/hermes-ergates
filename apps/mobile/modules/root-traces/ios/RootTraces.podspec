Pod::Spec.new do |s|
  s.name           = 'RootTraces'
  s.version        = '0.1.0'
  s.summary        = 'Finds files a jailbreak leaves on an iPhone.'
  s.description    = 'Finds files a jailbreak leaves on an iPhone, for the Ergates device trust check.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
