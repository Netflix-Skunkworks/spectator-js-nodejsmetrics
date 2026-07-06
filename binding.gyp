{
  'variables': {
    'cpp_version': "17",
    'conditions': [
        [ 'node_module_version >= 130', {
            'cpp_version': "20"
        }]
    ]
  },
  'targets': [
    {
      'target_name': 'spectator_internals',
      'dependencies': [],
      'sources': [
        "internals/functions.cc",
        "internals/runtime_metrics_native.cc"
      ],
      'include_dirs' : [
        "<!(node -e \"require('nan')\")"
      ],
      'conditions': [
        [ 'OS=="mac"', {
          'xcode_settings': {
            'OTHER_CPLUSPLUSFLAGS' : ['-stdlib=libc++', '-v', '-std=c++<(cpp_version)', '-Wall', '-Wextra', '-Wno-unused-parameter', '-g', '-O2' ],
            'OTHER_LDFLAGS': ['-stdlib=libc++'],
            'MACOSX_DEPLOYMENT_TARGET': '10.12',
            'GCC_ENABLE_CPP_EXCEPTIONS': 'NO'
          }
        }],
        ['OS=="linux"', {
          'cflags_cc': ['-std=c++<(cpp_version)', '-Wall', '-Wextra', '-Wno-unused-parameter', '-g', '-O2' ]
        }]
      ]
    }
  ]
}
